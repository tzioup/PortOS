import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../services/api';

export const BEEPER_DEFAULT_BASE_URL = 'http://127.0.0.1:23373';

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 5,
  baseUrl: BEEPER_DEFAULT_BASE_URL,
  attachmentBudgetGb: 5,
};

const clampInterval = (value) => Math.max(1, Math.min(1440, Math.floor(Number(value) || DEFAULTS.intervalMinutes)));
const clampBudget = (value) => Math.max(0.1, Math.min(1000, Number(value) || DEFAULTS.attachmentBudgetGb));

// settings.beeper.{enabled,intervalMinutes,baseUrl,attachmentBudgetGb} — the
// ingestion + connection config this slice's Comms → Beeper card edits (#30).
// Deliberately never reads or writes `token`/`tokenExpiresAt`: the server
// strips the token from every GET /api/settings response and rejects a
// `beeper` PUT that includes one — durable, encrypted token storage is fork
// issue #31's scope (OAuth connect + vault).
//
// `save()` always PUTs the complete four-field object, never a diff — same
// convention as `useSyncSourceSettings` for iMessage/Signal/Spotify/YouTube —
// so a partial edit can never silently drop a sibling field on the server's
// generic top-level shallow merge.
export function useBeeperSettings() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(DEFAULTS);
  const [saved, setSaved] = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getSettings({ silent: true })
      .then((settings) => {
        if (!active) return;
        const config = settings?.beeper || {};
        const next = {
          enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULTS.enabled,
          intervalMinutes: Number.isFinite(config.intervalMinutes) ? config.intervalMinutes : DEFAULTS.intervalMinutes,
          baseUrl: typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : DEFAULTS.baseUrl,
          attachmentBudgetGb: Number.isFinite(config.attachmentBudgetGb) ? config.attachmentBudgetGb : DEFAULTS.attachmentBudgetGb,
        };
        setForm(next);
        setSaved(next);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const dirty = Object.keys(DEFAULTS).some((key) => String(form[key]) !== String(saved[key]));

  const save = async () => {
    const next = {
      enabled: form.enabled,
      intervalMinutes: clampInterval(form.intervalMinutes),
      attachmentBudgetGb: clampBudget(form.attachmentBudgetGb),
      baseUrl: (form.baseUrl || '').trim() || DEFAULTS.baseUrl,
    };
    setSaving(true);
    const settings = await updateSettings({ beeper: next }).catch(() => null);
    setSaving(false);
    if (!settings) return false;
    setForm(next);
    setSaved(next);
    return true;
  };

  return { loading, form, setForm, saving, dirty, save };
}

export default useBeeperSettings;

'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuditCompetitor, AuditFinding, AuditPayload } from '@/lib/types';
import { normalizeDomain } from '@/lib/domain';

const TOKEN_KEY = 'audit_admin_token';
const SAVE_DEBOUNCE_MS = 800;
const FINDING_ICONS = ['sell', 'star', 'image', 'local_offer', 'title', 'visibility_off'];

const PREVIEW_STEPS = [
  { n: 0, label: 'Intro', hint: 'Before ad & problem findings' },
  { n: 1, label: 'The fix', hint: 'Optimized after ad' },
  { n: 2, label: 'Stand out', hint: 'Search term & competitor row' },
  { n: 3, label: 'The cost', hint: 'Calculator defaults' },
  { n: 4, label: 'Booking', hint: 'Static slide' },
] as const;

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

type AuditRow = {
  domain: string;
  status: string;
  payload: AuditPayload | null;
  generated_at: string | null;
  error_message: string | null;
  updated_at: string | null;
};

function emptyPayload(domain: string): AuditPayload {
  const brand = domain.split('.')[0];
  return {
    brand: { name: brand, domain, logo_url: null, logo_alt: null },
    search_term: '',
    ad_before: { img: '', title: '', price: '', store: domain },
    ad_after: {
      img: '',
      title: '',
      price: '',
      was: '',
      rating: null,
      reviews: null,
      sale: true,
      free_shipping: true,
    },
    findings: FINDING_ICONS.map((icon) => ({ icon, title: '', body: '' })),
    competitors: Array.from({ length: 4 }, () => ({ img: null, title: '', price: '', store: '' })),
    calc: { aov: 0, products: 1, spend: 15000, cpc: 1.2, cvr: 1.6, ctr_uplift: 20, cvr_uplift: 25 },
  };
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export default function AdminEditPage() {
  const [authed, setAuthed] = useState(false);
  const [token, setToken] = useState('');
  const [secretDraft, setSecretDraft] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [domain, setDomain] = useState('');
  const [row, setRow] = useState<AuditRow | null>(null);
  const [payload, setPayload] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState('');
  const [error, setError] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [previewStep, setPreviewStep] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const skipNextSave = useRef(false);
  const saveGen = useRef(0);
  const didUrlAutoLoad = useRef(false);

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) {
      setToken(saved);
      setAuthed(true);
    }
    const q = new URLSearchParams(window.location.search).get('domain');
    const normalized = normalizeDomain(q);
    if (normalized) {
      setDomainInput(normalized);
      setDomain(normalized);
    }
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'vulcan-audit-step' && typeof e.data.step === 'number') {
        setPreviewStep(Math.max(0, Math.min(4, e.data.step)));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const goToPreviewStep = useCallback((n: number) => {
    const step = Math.max(0, Math.min(4, n));
    setPreviewStep(step);
    iframeRef.current?.contentWindow?.postMessage({ type: 'vulcan-audit-goto', step }, window.location.origin);
  }, []);

  const load = useCallback(async (domainOverride?: string, opts?: { silent?: boolean }) => {
    const d = normalizeDomain(domainOverride ?? domainInput);
    if (!d) {
      setError('Enter a domain');
      return;
    }
    if (!token) {
      setError('Enter the admin secret');
      return;
    }
    setDomainInput(d);
    if (!opts?.silent) setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/audit?domain=${encodeURIComponent(d)}`, {
        headers: authHeaders(token),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setDomain(json.domain);
      setRow(json);
      skipNextSave.current = true;
      setPayload(json.payload ? structuredClone(json.payload) : emptyPayload(json.domain));
      setSaveStatus(json.payload ? 'saved' : 'idle');
      setSaveError('');
      setPreviewKey((k) => k + 1);
      setPreviewStep(0);
      window.history.replaceState(null, '', `/admin/edit?domain=${encodeURIComponent(json.domain)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setRow(null);
      setPayload(null);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [domainInput, token]);

  const regenerate = useCallback(async () => {
    const d = normalizeDomain(domainInput);
    if (!d) {
      setError('Enter a domain');
      return;
    }
    if (!token) {
      setError('Enter the admin secret');
      return;
    }
    if (saveStatus === 'pending' || saveStatus === 'saving') {
      if (!confirm('Unsaved edits will be lost. Regenerate the full audit from scratch?')) return;
    }
    saveGen.current += 1;
    setRegenerating(true);
    setError('');
    try {
      const res = await fetch('/api/audits', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ domain: d }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(typeof json.error === 'string' ? json.error : 'Failed to start regeneration');
      }
      setRow((r) =>
        r
          ? { ...r, status: 'generating', error_message: null }
          : { domain: d, status: 'generating', payload: null, generated_at: null, error_message: null, updated_at: null },
      );

      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const check = await fetch(`/api/admin/audit?domain=${encodeURIComponent(d)}`, {
          headers: authHeaders(token),
        });
        const rowJson = await check.json();
        if (!check.ok) throw new Error(rowJson.error || 'Failed to check status');
        setRow(rowJson);
        if (rowJson.status === 'ready') {
          await load(d, { silent: true });
          return;
        }
        if (rowJson.status === 'failed') {
          throw new Error(rowJson.error_message || 'Generation failed');
        }
      }
      throw new Error('Generation is still running — try Load again in a few minutes');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Regeneration failed');
    } finally {
      setRegenerating(false);
    }
  }, [domainInput, token, saveStatus, load]);

  useEffect(() => {
    if (!authed || !token || didUrlAutoLoad.current) return;
    const d = normalizeDomain(new URLSearchParams(window.location.search).get('domain'));
    if (!d) return;
    didUrlAutoLoad.current = true;
    void load(d);
  }, [authed, token, load]);

  useEffect(() => {
    if (!authed || !domain || !token || !payload) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }

    setSaveStatus('pending');
    setSaveError('');
    const gen = ++saveGen.current;

    const timer = window.setTimeout(async () => {
      if (gen !== saveGen.current) return;
      setSaveStatus('saving');
      try {
        const res = await fetch('/api/admin/audit', {
          method: 'PATCH',
          headers: authHeaders(token),
          body: JSON.stringify({ domain, payload }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || json.detail || 'Save failed');
        if (gen !== saveGen.current) return;
        setSaveStatus('saved');
        setRow((r) => (r ? { ...r, status: json.status, updated_at: json.updated_at } : r));
        setPreviewKey((k) => k + 1);
      } catch (e) {
        if (gen !== saveGen.current) return;
        setSaveStatus('error');
        setSaveError(e instanceof Error ? e.message : 'Save failed');
      }
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [authed, domain, token, payload]);

  const signIn = () => {
    const t = secretDraft.trim();
    if (!t) {
      setError('Enter the admin secret');
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    setAuthed(true);
    setError('');
  };

  const signOut = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setSecretDraft('');
    setAuthed(false);
  };

  const previewUrl = useMemo(() => (domain ? `/?domain=${encodeURIComponent(domain)}` : '/'), [domain]);

  const previewSrc = useMemo(
    () => (domain ? `/?domain=${encodeURIComponent(domain)}&embed=1&_=${previewKey}` : ''),
    [domain, previewKey],
  );

  const patch = <K extends keyof AuditPayload>(key: K, value: AuditPayload[K]) => {
    setPayload((p) => (p ? { ...p, [key]: value } : p));
  };

  const uploadImage = async (slot: string, file: File, onUrl: (url: string) => void) => {
    if (!domain || !token) return;
    const fd = new FormData();
    fd.append('domain', domain);
    fd.append('slot', slot);
    fd.append('file', file);
    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    onUrl(json.url);
  };

  if (!authed) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Audit editor</h1>
          <p style={styles.muted}>Sign in with the same secret used for <code>POST /api/audits</code>.</p>
          {error && <div style={styles.error}>{error}</div>}
          <label style={styles.label}>
            Admin secret
            <input
              type="password"
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && signIn()}
              style={styles.input}
              placeholder="AUDITS_TRIGGER_SECRET"
              autoComplete="off"
            />
          </label>
          <button type="button" onClick={signIn} style={styles.primaryBtn} disabled={!secretDraft.trim()}>
            Continue
          </button>
        </div>
      </main>
    );
  }

  const saveLabel =
    saveStatus === 'pending'
      ? 'Unsaved changes…'
      : saveStatus === 'saving'
        ? 'Saving…'
        : saveStatus === 'saved'
          ? 'Saved'
          : saveStatus === 'error'
            ? `Save failed${saveError ? `: ${saveError}` : ''}`
            : '';

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.h1}>Audit editor</h1>
          <p style={styles.muted}>Changes save automatically</p>
        </div>
        <div style={styles.headerRight}>
          <label style={styles.labelInline}>
            Domain
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              style={styles.input}
              placeholder="grip6.com"
              onKeyDown={(e) => e.key === 'Enter' && void load()}
            />
          </label>
          <button type="button" onClick={() => void load()} style={styles.secondaryBtn} disabled={loading || regenerating}>
            {loading ? 'Loading…' : 'Load'}
          </button>
          <button
            type="button"
            onClick={() => void regenerate()}
            style={styles.regenBtn}
            disabled={loading || regenerating || !domainInput.trim()}
            title="Re-run research, copy, images, and product curation"
          >
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
          {row && (
            <span style={styles.badge}>
              {row.status}
              {row.updated_at ? ` · updated ${new Date(row.updated_at).toLocaleString()}` : ''}
            </span>
          )}
          {saveLabel && (
            <span
              style={{
                ...styles.saveStatus,
                ...(saveStatus === 'saved' ? styles.saveStatusOk : {}),
                ...(saveStatus === 'error' ? styles.saveStatusErr : {}),
              }}
            >
              {saveLabel}
            </span>
          )}
          <button type="button" onClick={signOut} style={styles.ghostBtn}>
            Sign out
          </button>
        </div>
      </header>

      {error && <div style={styles.error}>{error}</div>}

      {payload && (
        <div style={styles.workspace}>
          <div style={styles.editPane}>
            <div style={styles.stepBar}>
              <div style={styles.stepBarTop}>
                <span style={styles.stepEyebrow}>Slide {previewStep + 1} of 5</span>
                <span style={styles.stepHint}>{PREVIEW_STEPS[previewStep].hint}</span>
              </div>
              <div style={styles.stepDots}>
                {PREVIEW_STEPS.map((s) => (
                  <button
                    key={s.n}
                    type="button"
                    title={s.label}
                    onClick={() => goToPreviewStep(s.n)}
                    style={{
                      ...styles.stepDot,
                      ...(previewStep === s.n ? styles.stepDotOn : {}),
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <StepEditors
              step={previewStep}
              payload={payload}
              patch={patch}
              uploadImage={uploadImage}
            />
          </div>

          <aside style={styles.previewPane}>
            <div style={styles.previewBar}>
              <div>
                <div style={styles.previewTitle}>Live preview</div>
                <div style={styles.previewHint}>Updates after each save · {domain}</div>
              </div>
              <a href={previewUrl} target="_blank" rel="noopener noreferrer" style={styles.previewOpen}>
                Open ↗
              </a>
            </div>
            {previewSrc ? (
              <iframe ref={iframeRef} key={previewSrc} title="Audit preview" src={previewSrc} style={styles.previewFrame} />
            ) : (
              <div style={styles.previewEmpty}>Load a domain to see the audit page</div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function StepEditors({
  step,
  payload,
  patch,
  uploadImage,
}: {
  step: number;
  payload: AuditPayload;
  patch: <K extends keyof AuditPayload>(key: K, value: AuditPayload[K]) => void;
  uploadImage: (slot: string, file: File, onUrl: (url: string) => void) => Promise<void>;
}) {
  if (step === 0) {
    return (
      <>
        <Section title="Brand">
          <ImageField
            label="Logo"
            value={payload.brand.logo_url ?? ''}
            onChange={(v) => patch('brand', { ...payload.brand, logo_url: v || null })}
            onUpload={(f) =>
              uploadImage('brand-logo', f, (url) => patch('brand', { ...payload.brand, logo_url: url, logo_alt: `${payload.brand.name} logo` }))
            }
          />
          <Field label="Brand name" value={payload.brand.name} onChange={(v) => patch('brand', { ...payload.brand, name: v })} />
          <p style={styles.hint}>Logo is fetched from Context.dev on generate/load when CONTEXT_DEV_API_KEY is set. Falls back to name if missing.</p>
        </Section>
        <Section title="Before ad">
          <ImageField
            label="Image"
            value={payload.ad_before.img}
            onChange={(v) => patch('ad_before', { ...payload.ad_before, img: v })}
            onUpload={(f) => uploadImage('before', f, (url) => patch('ad_before', { ...payload.ad_before, img: url }))}
          />
          <Field label="Title" value={payload.ad_before.title} onChange={(v) => patch('ad_before', { ...payload.ad_before, title: v })} />
          <div style={styles.row2}>
            <Field label="Price" value={payload.ad_before.price} onChange={(v) => patch('ad_before', { ...payload.ad_before, price: v })} />
            <Field label="Store" value={payload.ad_before.store} onChange={(v) => patch('ad_before', { ...payload.ad_before, store: v })} />
          </div>
        </Section>
        <Section title="Findings">
          {payload.findings.map((f, i) => (
            <FindingEditor
              key={i}
              finding={f}
              onChange={(finding) => {
                const findings = [...payload.findings];
                findings[i] = finding;
                patch('findings', findings);
              }}
            />
          ))}
        </Section>
      </>
    );
  }

  if (step === 1) {
    return (
      <Section title="After ad">
        <ImageField
          label="Image"
          value={payload.ad_after.img}
          onChange={(v) => patch('ad_after', { ...payload.ad_after, img: v })}
          onUpload={(f) => uploadImage('after', f, (url) => patch('ad_after', { ...payload.ad_after, img: url }))}
        />
        <Field label="Title" value={payload.ad_after.title} onChange={(v) => patch('ad_after', { ...payload.ad_after, title: v })} />
        <div style={styles.row2}>
          <Field label="Price" value={payload.ad_after.price} onChange={(v) => patch('ad_after', { ...payload.ad_after, price: v })} />
          <Field label="Was price" value={payload.ad_after.was} onChange={(v) => patch('ad_after', { ...payload.ad_after, was: v })} />
        </div>
        <div style={styles.row2}>
          <NumField label="Rating" value={payload.ad_after.rating} onChange={(v) => patch('ad_after', { ...payload.ad_after, rating: v })} />
          <NumField label="Reviews" value={payload.ad_after.reviews} onChange={(v) => patch('ad_after', { ...payload.ad_after, reviews: v })} />
        </div>
        <div style={styles.checkRow}>
          <label style={styles.check}>
            <input type="checkbox" checked={payload.ad_after.sale} onChange={(e) => patch('ad_after', { ...payload.ad_after, sale: e.target.checked })} />
            Sale badge
          </label>
          <label style={styles.check}>
            <input type="checkbox" checked={payload.ad_after.free_shipping} onChange={(e) => patch('ad_after', { ...payload.ad_after, free_shipping: e.target.checked })} />
            Free shipping
          </label>
        </div>
      </Section>
    );
  }

  if (step === 2) {
    return (
      <>
        <Section title="Search row">
          <Field label="Search term" value={payload.search_term} onChange={(v) => patch('search_term', v)} />
        </Section>
        <Section title="Your optimized ad (center card)">
          <p style={styles.hint}>Shown after the visitor clicks Optimize. Uses the after-ad fields from slide 2.</p>
          <ImageField
            label="Image"
            value={payload.ad_after.img}
            onChange={(v) => patch('ad_after', { ...payload.ad_after, img: v })}
            onUpload={(f) => uploadImage('after', f, (url) => patch('ad_after', { ...payload.ad_after, img: url }))}
          />
          <Field label="Title" value={payload.ad_after.title} onChange={(v) => patch('ad_after', { ...payload.ad_after, title: v })} />
          <Field label="Price" value={payload.ad_after.price} onChange={(v) => patch('ad_after', { ...payload.ad_after, price: v })} />
          <NumField label="Rating" value={payload.ad_after.rating} onChange={(v) => patch('ad_after', { ...payload.ad_after, rating: v })} />
        </Section>
        <Section title="Competitors">
          {payload.competitors.map((c, i) => (
            <CompetitorEditor
              key={i}
              index={i}
              competitor={c}
              onChange={(competitor) => {
                const competitors = [...payload.competitors];
                competitors[i] = competitor;
                patch('competitors', competitors);
              }}
              onUpload={(f) =>
                uploadImage(`comp-${i}`, f, (url) => {
                  const competitors = [...payload.competitors];
                  competitors[i] = { ...competitors[i], img: url };
                  patch('competitors', competitors);
                })
              }
            />
          ))}
        </Section>
      </>
    );
  }

  if (step === 3) {
    return (
      <Section title="Calculator defaults">
        <p style={styles.hint}>Powers the ROAS math on this slide. Monthly ad spend is entered by the visitor on the phone.</p>
        <div style={styles.row2}>
          <NumField label="AOV ($)" value={payload.calc.aov} onChange={(v) => patch('calc', { ...payload.calc, aov: v ?? 0 })} />
          <NumField label="Product count" value={payload.calc.products} onChange={(v) => patch('calc', { ...payload.calc, products: v ?? 1 })} />
        </div>
        <div style={styles.row2}>
          <NumField label="CPC ($)" value={payload.calc.cpc} onChange={(v) => patch('calc', { ...payload.calc, cpc: v ?? 0 })} step={0.01} />
          <NumField label="CVR (%)" value={payload.calc.cvr} onChange={(v) => patch('calc', { ...payload.calc, cvr: v ?? 0 })} step={0.1} />
        </div>
        <div style={styles.row2}>
          <NumField label="CTR uplift (%)" value={payload.calc.ctr_uplift} onChange={(v) => patch('calc', { ...payload.calc, ctr_uplift: v ?? 0 })} />
          <NumField label="CVR uplift (%)" value={payload.calc.cvr_uplift} onChange={(v) => patch('calc', { ...payload.calc, cvr_uplift: v ?? 0 })} />
        </div>
      </Section>
    );
  }

  return (
    <div style={styles.staticSlide}>
      <p style={styles.staticSlideTitle}>Nothing to edit on this slide</p>
      <p style={styles.hint}>The booking page is static — founders, video, and Calendly are baked into the template.</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={styles.label}>
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} style={styles.input} />
    </label>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
}) {
  return (
    <label style={styles.label}>
      {label}
      <input
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        style={styles.input}
      />
    </label>
  );
}

function ImageField({
  label,
  value,
  onChange,
  onUpload,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onUpload: (file: File) => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <div style={styles.imageField}>
      <label style={styles.label}>
        {label} URL
        <input value={value} onChange={(e) => onChange(e.target.value)} style={styles.input} placeholder="https://…" />
      </label>
      <div style={styles.imageRow}>
        {value ? <img src={value} alt="" style={styles.thumb} /> : <div style={styles.thumbEmpty}>No image</div>}
        <label style={styles.uploadBtn}>
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setUploading(true);
              try {
                await onUpload(file);
              } finally {
                setUploading(false);
                e.target.value = '';
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}

function FindingEditor({ finding, onChange }: { finding: AuditFinding; onChange: (f: AuditFinding) => void }) {
  return (
    <div style={styles.subcard}>
      <label style={styles.label}>
        Icon
        <select value={finding.icon} onChange={(e) => onChange({ ...finding, icon: e.target.value })} style={styles.input}>
          {FINDING_ICONS.map((icon) => (
            <option key={icon} value={icon}>
              {icon}
            </option>
          ))}
        </select>
      </label>
      <Field label="Title" value={finding.title} onChange={(v) => onChange({ ...finding, title: v })} />
      <label style={styles.label}>
        Body
        <textarea value={finding.body} onChange={(e) => onChange({ ...finding, body: e.target.value })} style={styles.textarea} rows={3} />
      </label>
    </div>
  );
}

function CompetitorEditor({
  index,
  competitor,
  onChange,
  onUpload,
}: {
  index: number;
  competitor: AuditCompetitor;
  onChange: (c: AuditCompetitor) => void;
  onUpload: (file: File) => Promise<void>;
}) {
  return (
    <div style={styles.subcard}>
      <div style={styles.subcardTitle}>Competitor {index + 1}</div>
      <ImageField
        label="Image"
        value={competitor.img ?? ''}
        onChange={(v) => onChange({ ...competitor, img: v || null })}
        onUpload={onUpload}
      />
      <Field label="Title" value={competitor.title} onChange={(v) => onChange({ ...competitor, title: v })} />
      <div style={styles.row2}>
        <Field label="Price" value={competitor.price} onChange={(v) => onChange({ ...competitor, price: v })} />
        <Field label="Store" value={competitor.store} onChange={(v) => onChange({ ...competitor, store: v })} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    height: '100vh',
    background: '#f4f6fb',
    padding: '20px 24px 24px',
    fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
    color: '#0f172a',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  card: { maxWidth: 420, margin: '80px auto', background: '#fff', borderRadius: 16, padding: 28, boxShadow: '0 8px 30px rgba(15,23,42,.08)' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 20,
    marginBottom: 12,
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
  headerRight: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', flex: 1, justifyContent: 'flex-end' },
  h1: { margin: 0, fontSize: 22, fontWeight: 800 },
  h2: { margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#334155' },
  muted: { margin: 0, color: '#64748b', fontSize: 13 },
  hint: { margin: '0 0 12px', color: '#64748b', fontSize: 13, lineHeight: 1.45 },
  labelInline: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#475569', minWidth: 200 },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 12 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 14, fontWeight: 500, background: '#fff' },
  textarea: { padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 14, fontWeight: 500, background: '#fff', resize: 'vertical' },
  primaryBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#2f6df6', color: '#fff', fontWeight: 700, cursor: 'pointer' },
  secondaryBtn: { padding: '10px 16px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', fontWeight: 700, cursor: 'pointer' },
  regenBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: '1px solid #f59e0b',
    background: '#fffbeb',
    color: '#92400e',
    fontWeight: 700,
    cursor: 'pointer',
  },
  ghostBtn: { padding: '10px 16px', borderRadius: 10, border: '1px solid #e2e8f0', background: 'transparent', fontWeight: 600, cursor: 'pointer' },
  saveStatus: { fontSize: 13, fontWeight: 600, color: '#64748b', padding: '8px 12px', borderRadius: 8, background: '#f1f5f9' },
  saveStatusOk: { color: '#047857', background: '#ecfdf5' },
  saveStatusErr: { color: '#b91c1c', background: '#fef2f2' },
  linkBtn: { padding: '10px 14px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', fontWeight: 600, textDecoration: 'none', color: '#0f172a' },
  badge: { fontSize: 12, color: '#64748b', paddingBottom: 10, whiteSpace: 'nowrap' },
  error: { background: '#fef2f2', color: '#b91c1c', padding: '10px 14px', borderRadius: 10, marginBottom: 12, fontSize: 14, flexShrink: 0 },
  workspace: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(380px, 440px) minmax(0, 1fr)',
    gap: 0,
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid #dbe4f5',
    background: '#fff',
    boxShadow: '0 8px 30px rgba(15,23,42,.06)',
  },
  editPane: {
    overflowY: 'auto',
    padding: '14px 14px 28px',
    borderRight: '1px solid #e2e8f0',
    background: '#f8fafc',
  },
  stepBar: {
    background: '#fff',
    borderRadius: 12,
    padding: '12px 14px',
    marginBottom: 14,
    border: '1px solid #e2e8f0',
  },
  stepBarTop: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 },
  stepEyebrow: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#64748b' },
  stepHint: { fontSize: 13, fontWeight: 600, color: '#0f172a' },
  stepDots: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  stepDot: {
    padding: '5px 10px',
    borderRadius: 999,
    border: '1px solid #dbe4f5',
    background: '#f8fafc',
    fontSize: 11,
    fontWeight: 700,
    color: '#64748b',
    cursor: 'pointer',
  },
  stepDotOn: { background: '#2f6df6', border: '1px solid #2f6df6', color: '#fff' },
  staticSlide: {
    background: '#fff',
    borderRadius: 14,
    padding: 24,
    textAlign: 'center',
    border: '1px dashed #cbd5e1',
  },
  staticSlideTitle: { margin: '0 0 8px', fontSize: 15, fontWeight: 700, color: '#334155' },
  previewPane: { display: 'flex', flexDirection: 'column', minHeight: 0, background: '#e9eef5' },
  previewBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    borderBottom: '1px solid #dbe4f5',
    background: '#fff',
    flexShrink: 0,
  },
  previewTitle: { fontSize: 14, fontWeight: 700, color: '#0f172a' },
  previewHint: { fontSize: 12, color: '#64748b', marginTop: 2 },
  previewOpen: { fontSize: 13, fontWeight: 600, color: '#2f6df6', textDecoration: 'none', whiteSpace: 'nowrap' },
  previewFrame: { flex: 1, width: '100%', border: 'none', background: '#fff' },
  previewEmpty: {
    flex: 1,
    display: 'grid',
    placeItems: 'center',
    color: '#64748b',
    fontSize: 14,
    padding: 24,
    textAlign: 'center',
  },
  section: { background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 2px 10px rgba(15,23,42,.04)', marginBottom: 14 },
  subcard: { background: '#f8fafc', borderRadius: 12, padding: 12, marginBottom: 10 },
  subcardTitle: { fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.04em' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  checkRow: { display: 'flex', gap: 16, marginBottom: 8 },
  check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 },
  imageField: { marginBottom: 8 },
  imageRow: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 },
  thumb: { width: 72, height: 72, objectFit: 'cover', borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff' },
  thumbEmpty: { width: 72, height: 72, borderRadius: 10, border: '1px dashed #cbd5e1', display: 'grid', placeItems: 'center', fontSize: 11, color: '#94a3b8', background: '#fff' },
  uploadBtn: { padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
};

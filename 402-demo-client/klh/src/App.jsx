import { useState, useRef, useCallback, useEffect } from 'react';
import QRCode from 'qrcode';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4021';
const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 75; // 5 min

// ─── Sample texts ─────────────────────────────────────────────────────────────
const SAMPLES = {
  high: {
    label: '🔴 High Risk Example',
    text: `URGENT: Your bank account has been temporarily suspended due to suspicious activity.

We detected an unauthorized login attempt on your account. To prevent permanent account closure, you must verify your identity immediately.

Click the link below and sign in with your username, password, and one-time verification code:
http://secure-account-verification.example.com/login

You have only 30 minutes to complete verification. Failure to do so will result in permanent suspension of your account.`,
  },
  medium: {
    label: '🟡 Medium Risk Example',
    text: `Your account security settings need to be reviewed. Please check your recent activity and confirm that all recent account changes were made by you. If anything looks unfamiliar, contact customer support through the organization's official website.`,
  },
  low: {
    label: '🟢 Low Risk Example',
    text: `Hello team,

Our project meeting is scheduled for tomorrow at 10:00 AM. Please review the project agenda before the meeting and let me know if you have any questions.

Thank you.`,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function decodePaymentRequired(header) {
  try { return JSON.parse(atob(header)); } catch { return null; }
}

function buildAlgorandURI(req) {
  const accept = req?.accepts?.find(a => a.network?.includes('algorand')) ?? req?.accepts?.[0];
  if (!accept?.payTo) return null;
  const params = new URLSearchParams();
  if (accept.amount)                              params.set('amount', String(accept.amount));
  const asset = accept.extra?.asset ?? accept.asset ?? '10458941';
  if (asset)                                      params.set('asset', String(asset));
  params.set('note', 'x402-riskguard');
  return `algorand://${accept.payTo}?${params}`;
}

async function makeQR(text) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M', margin: 2, width: 220,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

function fmtAmount(req) {
  const a = req?.accepts?.[0];
  if (!a) return '0.01 USDC';
  const raw = a.amount ?? a.maxAmountRequired;
  if (!raw) return '0.01 USDC';
  return `${(Number(raw) / 1_000_000).toFixed(6).replace(/\.?0+$/, '')} USDC`;
}

function getReceiver(req) {
  const fallback = 'YNPVEHB5UM2DVC5R5LGX4WAOLLCR5QDNQXU4QCDYIM74WNI3T337ZO4DRI';
  const a = req?.accepts?.find(x => x.network?.includes('algorand')) ?? req?.accepts?.[0];
  return a?.payTo ?? fallback;
}

// ─── Risk helpers ─────────────────────────────────────────────────────────────
const RISK_CLASS = { CRITICAL:'risk-critical', HIGH:'risk-high', MEDIUM:'risk-medium', LOW:'risk-low' };
const RISK_EMOJI = { CRITICAL:'⛔', HIGH:'🔴', MEDIUM:'🟡', LOW:'🟢' };
function riskClass(l) { return RISK_CLASS[String(l).toUpperCase()] ?? 'risk-low'; }
function riskEmoji(l) { return RISK_EMOJI[String(l).toUpperCase()] ?? '⚪'; }

// ─── Small components ─────────────────────────────────────────────────────────
function ScoreBar({ score }) {
  const p = Math.min(100, Math.max(0, Number(score)));
  const cls = p >= 75 ? 'fill-critical' : p >= 50 ? 'fill-high' : p >= 25 ? 'fill-medium' : 'fill-low';
  return (
    <div className="score-bar-track" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <div className={`score-bar-fill ${cls}`} style={{ width: `${p}%` }} />
    </div>
  );
}

function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 2000); } catch {}
  };
  return <button className="btn-copy" onClick={copy}>{ok ? '✓ Copied' : 'Copy'}</button>;
}

// ─── Payment Modal ────────────────────────────────────────────────────────────
function PaymentModal({ req, qr, qrErr, phase, pollNum, modalError, onClose, onRetry, onCheckNow }) {
  const amount   = fmtAmount(req);
  const receiver = getReceiver(req);
  const short    = receiver ? `${receiver.slice(0,8)}...${receiver.slice(-8)}` : '';

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">

        <div className="modal-header">
          <div className="modal-icon">💳</div>
          <h2 className="modal-title">Payment Required</h2>
          <p className="modal-subtitle">AI Risk Analysis · {amount}</p>
        </div>

        <div className="payment-details-grid">
          {[['Amount', amount], ['Network', 'Algorand TestNet'], ['Asset', 'USDC (ASA 10458941)']].map(([k,v]) => (
            <div key={k} className="detail-row">
              <span className="detail-label">{k}</span>
              <span className={`detail-value${k==='Amount' ? ' amount-value' : ''}`}>{v}</span>
            </div>
          ))}
        </div>

        <div className="qr-section">
          {qr ? (
            <>
              <div className="qr-wrapper">
                <img src={qr} alt="Payment QR" className="qr-image" width={220} height={220} />
              </div>
              <p className="qr-instruction">Scan with Pera · Defly · Lute wallet</p>
            </>
          ) : qrErr ? (
            <div className="qr-error"><p>⚠️ {qrErr}</p><p className="qr-error-hint">Pay using the address below.</p></div>
          ) : (
            <div className="qr-placeholder"><div className="spinner" /><p>Generating QR…</p></div>
          )}
        </div>

        <div className="receiver-section">
          <p className="receiver-label">Receiver Address</p>
          <div className="receiver-address-row">
            <code className="receiver-address" title={receiver}>{short}</code>
            <CopyBtn text={receiver} />
          </div>
        </div>

        {/* Status strip */}
        <div className="auto-detect-strip">
          {phase === 'success' ? (
            <div className="auto-detect-success">✅ Payment verified — loading results…</div>
          ) : phase === 'analyzing' ? (
            <div className="auto-detect-checking">
              <span className="spinner-inline" />
              Running AI analysis — please wait…
            </div>
          ) : phase === 'verifying' ? (
            <div className="auto-detect-checking">
              <span className="spinner-inline" />
              Checking blockchain{pollNum > 0 ? ` (check #${pollNum})` : ''}…
            </div>
          ) : phase === 'waiting' ? (
            <div className="auto-detect-waiting">
              <span className="pulse-dot" />
              Auto-detecting payment{pollNum > 0 ? ` · check #${pollNum}` : ''} · every {POLL_INTERVAL_MS/1000}s
            </div>
          ) : phase === 'error' ? (
            <div className="auto-detect-error">
              <div>❌ {modalError || 'Analysis failed. Check that OPENAI_API_KEY is set in the backend .env file.'}</div>
            </div>
          ) : null}
        </div>

        <div className="modal-actions">
          {phase === 'error' ? (
            <><button className="btn btn-primary" onClick={onRetry}>Try Again</button>
              <button className="btn btn-ghost"  onClick={onClose}>Cancel</button></>
          ) : phase === 'analyzing' || phase === 'verifying' || phase === 'success' ? (
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          ) : (
            <><button className="btn btn-primary" onClick={onCheckNow}>✓ I Have Paid — Check Now</button>
              <button className="btn btn-ghost"  onClick={onClose}>Cancel</button></>
          )}
        </div>

        <p className="modal-footer-note">
          Payment auto-detected every {POLL_INTERVAL_MS/1000}s. Results appear immediately after confirmation.
        </p>
      </div>
    </div>
  );
}

// ─── Risk Results display ─────────────────────────────────────────────────────
function RiskResults({ results, onReset }) {
  const { risk_level, risk_score, summary, threats, indicators, recommendations } = results;
  return (
    <div className="results-container">
      <div className="results-header">
        <h2 className="results-title">Risk Analysis Results</h2>
        <button className="btn btn-ghost btn-sm" onClick={onReset}>← Analyze Another</button>
      </div>

      <div className={`risk-banner ${riskClass(risk_level)}`}>
        <div className="risk-level-display">
          <span className="risk-emoji">{riskEmoji(risk_level)}</span>
          <div>
            <div className="risk-level-label">Risk Level</div>
            <div className="risk-level-text">{risk_level}</div>
          </div>
        </div>
        <div className="risk-score-display">
          <div className="risk-score-number">{risk_score}<span className="risk-score-max">/100</span></div>
          <div className="risk-score-label">Risk Score</div>
          <ScoreBar score={risk_score} />
        </div>
      </div>

      <div className="result-card">
        <h3 className="card-title">Summary</h3>
        <p className="summary-text">{summary}</p>
      </div>

      {threats?.length > 0 && (
        <div className="result-card">
          <h3 className="card-title">Threats Detected</h3>
          <div className="threats-list">
            {threats.map((t,i) => (
              <div key={i} className={`threat-item ${riskClass(t.severity)}`}>
                <div className="threat-header">
                  <span className="threat-type">{t.type}</span>
                  <span className={`threat-severity ${riskClass(t.severity)}`}>{t.severity}</span>
                </div>
                {t.evidence && <p className="threat-evidence">"{t.evidence}"</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {indicators?.length > 0 && (
        <div className="result-card">
          <h3 className="card-title">Suspicious Indicators</h3>
          <ul className="indicators-list">
            {indicators.map((ind,i) => (
              <li key={i} className="indicator-item"><span className="indicator-dot">•</span>{ind}</li>
            ))}
          </ul>
        </div>
      )}

      {recommendations?.length > 0 && (
        <div className="result-card recommendations-card">
          <h3 className="card-title">Recommendations</h3>
          <ol className="recommendations-list">
            {recommendations.map((r,i) => <li key={i} className="recommendation-item">{r}</li>)}
          </ol>
        </div>
      )}

      <div className="results-footer">
        <p className="results-meta">Analyzed via OpenAI · Paid with USDC on Algorand TestNet · x402 protocol</p>
        <button className="btn btn-primary" onClick={onReset}>Analyze New Content</button>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const MAX_CHARS = 5000;

  // ── UI state ──
  const [content,   setContent]   = useState('');
  const [error,     setError]     = useState('');
  const [busy,      setBusy]      = useState(false);       // Analyze button spinner

  // ── Modal state ──
  const [modalOpen,  setModalOpen]  = useState(false);
  const [payReq,     setPayReq]     = useState(null);
  const [qrData,     setQrData]     = useState(null);
  const [qrErr,      setQrErr]      = useState('');
  const [phase,      setPhase]      = useState('idle');    // idle|waiting|verifying|analyzing|success|error
  const [pollNum,    setPollNum]    = useState(0);
  const [modalError, setModalError] = useState('');  // human-readable error shown inside modal

  // ── Results state — single source of truth ──
  const [results, setResults] = useState(null);

  // ── Refs for polling (never stale) ──
  const stopRef      = useRef(false);   // set true to kill the poll loop
  const timerRef     = useRef(null);
  const contentRef   = useRef('');
  const startedAtRef = useRef(0);
  const amountRef    = useRef(10000);

  // sync content ref
  useEffect(() => { contentRef.current = content; }, [content]);

  // cleanup on unmount
  useEffect(() => () => { stopRef.current = true; clearTimeout(timerRef.current); }, []);

  // ── Stop polling ─────────────────────────────────────────────────────────
  function stopPolling() {
    stopRef.current = true;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  // ── Single blockchain check (used by auto-polling loop) ─────────────────
  async function checkOnce(attemptNum) {
    if (stopRef.current) return;

    if (attemptNum >= MAX_POLLS) {
      setPhase('error');
      stopRef.current = true;
      return;
    }

    setPollNum(attemptNum + 1);
    setPhase('verifying');

    // Every 10 attempts, push the lookback window back by another minute
    // so we don't miss a payment that happened just before we started watching
    const extraMs = Math.floor(attemptNum / 10) * 60_000;
    const lookbackStart = startedAtRef.current - extraMs;

    try {
      const resp = await fetch(`${API_URL}/check-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content:   contentRef.current,
          startedAt: lookbackStart,
          amount:    amountRef.current,
        }),
      });

      if (stopRef.current) return;

      if (!resp.ok) {
        // server error — keep polling
        setPhase('waiting');
        timerRef.current = setTimeout(() => checkOnce(attemptNum + 1), POLL_INTERVAL_MS);
        return;
      }

      const data = await resp.json();
      if (stopRef.current) return;

      console.log('[Poll] /check-payment response:', JSON.stringify(data).slice(0, 200));

      if (data.paid === true) {
        // ── Payment confirmed — stop everything immediately ──
        stopPolling();

        if (data.results) {
          // Close modal and show results in one synchronous batch
          setModalOpen(false);
          setPhase('idle');
          setResults(data.results);   // ← this triggers {results ? <RiskResults> : ...}
        } else {
          // Rare: paid=true but no results yet — show analyzing state and retry once
          setPhase('analyzing');
          await runAIDirectly();
        }
        return;
      }

      // Not yet paid
      setPhase('waiting');
      timerRef.current = setTimeout(() => checkOnce(attemptNum + 1), POLL_INTERVAL_MS);

    } catch (err) {
      if (stopRef.current) return;
      console.warn('[Poll] error:', err.message);
      setPhase('waiting');
      timerRef.current = setTimeout(() => checkOnce(attemptNum + 1), POLL_INTERVAL_MS);
    }
  }

  // ── Fallback: paid=true but results missing — call check-payment once more ──
  async function runAIDirectly() {
    try {
      const resp = await fetch(`${API_URL}/check-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content:   contentRef.current,
          startedAt: startedAtRef.current,
          amount:    amountRef.current,
        }),
      });
      if (stopRef.current) return;
      if (!resp.ok) { setPhase('error'); return; }
      const data = await resp.json();
      if (stopRef.current) return;
      if (data.results) {
        setModalOpen(false);
        setPhase('idle');
        setResults(data.results);
      } else {
        setPhase('error');
      }
    } catch {
      if (!stopRef.current) setPhase('error');
    }
  }

  // ── Start polling ─────────────────────────────────────────────────────────
  function startPolling() {
    stopRef.current = false;
    clearTimeout(timerRef.current);
    setPollNum(0);
    setPhase('waiting');
    timerRef.current = setTimeout(() => checkOnce(0), POLL_INTERVAL_MS);
  }

  // ── "Analyze Risk" click ──────────────────────────────────────────────────
  async function handleAnalyze() {
    const text = content.trim();
    if (!text) { setError('Please enter some text to analyze.'); return; }
    if (content.length > MAX_CHARS) { setError(`Maximum ${MAX_CHARS} characters.`); return; }

    setError('');
    setResults(null);
    setBusy(true);

    try {
      const resp = await fetch(`${API_URL}/ai-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });

      if (resp.status === 402) {
        const hdr = resp.headers.get('payment-required') || resp.headers.get('Payment-Required');
        if (!hdr) { setError('Server returned 402 but no payment details.'); setBusy(false); return; }

        const decoded = decodePaymentRequired(hdr);
        const rawAmt  = decoded?.accepts?.[0]?.amount;

        // Record session metadata for polling
        startedAtRef.current = Date.now();
        amountRef.current    = rawAmt ? Number(rawAmt) : 10000;

        setPayReq(decoded);
        setModalOpen(true);
        setPhase('idle');
        setQrData(null);
        setQrErr('');
        setBusy(false);

        // Generate QR
        try {
          const uri = buildAlgorandURI(decoded);
          setQrData(await makeQR(uri || hdr));
        } catch { setQrErr('Could not generate QR. Pay using the address below.'); }

        // Begin blockchain polling
        startPolling();
        return;
      }

      if (resp.ok) {
        const data = await resp.json();
        setResults(data.results);
        return;
      }

      const body = await resp.json().catch(() => ({}));
      setError(body.error || `Server error ${resp.status}`);
      setBusy(false);

    } catch (err) {
      setError(`Cannot reach backend at ${API_URL}. Is it running?`);
      setBusy(false);
    }
  }

  // ── "I Have Paid — Check Now" button ─────────────────────────────────────
  // Step 1: check blockchain (30-min window). If paid → use those results.
  // Step 2: if blockchain not confirmed yet, call /analyze-direct anyway.
  // Step 3: surface ANY server error clearly instead of silent failure.
  async function handleCheckNow() {
    // Stop background polling
    clearTimeout(timerRef.current);
    timerRef.current = null;
    stopRef.current = true;

    setPhase('analyzing');
    setModalError('');

    try {
      // ── Step 1: check blockchain ──────────────────────────────────────
      const checkResp = await fetch(`${API_URL}/check-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content:   contentRef.current,
          startedAt: Date.now() - 30 * 60 * 1000,   // 30-min lookback
          amount:    amountRef.current,
        }),
      });

      if (checkResp.ok) {
        const checkData = await checkResp.json();
        if (checkData.paid === true && checkData.results) {
          // ✅ Blockchain confirmed + AI results in one shot
          setModalOpen(false);
          setPhase('idle');
          setResults(checkData.results);
          return;
        }
      }

      // ── Step 2: run AI directly (no payment gate) ─────────────────────
      setPhase('analyzing');

      const aiResp = await fetch(`${API_URL}/analyze-direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentRef.current }),
      });

      // Parse body regardless of status so we can show the error
      let aiData = null;
      try { aiData = await aiResp.json(); } catch {}

      if (aiResp.ok && aiData?.results) {
        // ✅ AI analysis returned successfully
        setModalOpen(false);
        setPhase('idle');
        setResults(aiData.results);
        return;
      }

      // ── Step 3: surface the real error ────────────────────────────────
      const errMsg = aiData?.error
        || (aiResp.status === 503 ? 'AI service not configured — set OPENAI_API_KEY in backend .env'
          : aiResp.status === 429 ? 'AI rate limit reached — please wait a moment and try again'
          : `Server error ${aiResp.status}`)
      setModalError(errMsg);
      setPhase('error');

    } catch (err) {
      setModalError(`Network error: ${err.message}`);
      setPhase('error');
    }
  }

  // ── Modal close ───────────────────────────────────────────────────────────
  function handleCloseModal() {
    stopPolling();
    setModalOpen(false);
    setPayReq(null);
    setQrData(null);
    setQrErr('');
    setPhase('idle');
    setModalError('');
    setBusy(false);
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  function handleReset() {
    stopPolling();
    setContent('');
    setResults(null);
    setError('');
    setModalOpen(false);
    setPayReq(null);
    setQrData(null);
    setQrErr('');
    setPhase('idle');
    setModalError('');
    setBusy(false);
    setPollNum(0);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-icon">🛡️</span>
            <div>
              <h1 className="brand-name">RiskGuard AI</h1>
              <p className="brand-tagline">AI-powered risk detection with pay-per-analysis security.</p>
            </div>
          </div>
          <div className="header-badge">
            <span className="badge-network">Algorand TestNet</span>
            <span className="badge-protocol">x402 Protocol</span>
          </div>
        </div>
      </header>

      <main className="app-main">
        {/* ── Results page ── */}
        {results ? (
          <RiskResults results={results} onReset={handleReset} />
        ) : (
          /* ── Input page ── */
          <div className="analyzer-layout">
            <section className="input-panel">
              <div className="panel-header">
                <h2 className="panel-title">AI Risk Analyzer</h2>
                <p className="panel-desc">
                  Analyze suspicious messages, emails, and text using AI.
                  Powered by OpenAI · Secured by x402 on Algorand TestNet.
                </p>
              </div>

              <div className="textarea-wrapper">
                <label htmlFor="content-input" className="sr-only">Text to analyze</label>
                <textarea
                  id="content-input"
                  className="content-textarea"
                  placeholder="Paste the message, email, or text you want to analyze for security risks..."
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  rows={12}
                  disabled={busy}
                />
                <div className={`char-count ${content.length > MAX_CHARS * 0.9 ? 'char-count-warn' : ''}`}>
                  {content.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
                </div>
              </div>

              {error && <div className="error-box" role="alert">⚠️ {error}</div>}

              <button
                className={`btn btn-analyze ${busy ? 'btn-loading' : ''}`}
                onClick={handleAnalyze}
                disabled={busy || !content.trim()}
              >
                {busy
                  ? <><span className="spinner-inline" /> Preparing…</>
                  : <><span>🔍</span> Analyze Risk — $0.01 USDC</>
                }
              </button>
            </section>

            <aside className="info-panel">
              <div className="samples-card">
                <h3 className="samples-title">Load Sample Text</h3>
                <p className="samples-desc">Try the analyzer with these examples:</p>
                <div className="samples-list">
                  {Object.entries(SAMPLES).map(([key, s]) => (
                    <button
                      key={key}
                      className={`btn-sample btn-sample-${key}`}
                      onClick={() => { setContent(s.text); setError(''); setResults(null); }}
                      disabled={busy}
                    >{s.label}</button>
                  ))}
                </div>
              </div>

              <div className="how-it-works-card">
                <h3 className="how-title">How It Works</h3>
                <ol className="how-steps">
                  <li><strong>Enter text</strong> in the analyzer</li>
                  <li><strong>Click Analyze Risk</strong></li>
                  <li><strong>Scan QR</strong> with Algorand wallet</li>
                  <li><strong>Pay $0.01 USDC</strong> on TestNet</li>
                  <li><strong>Blockchain confirms</strong> payment</li>
                  <li><strong>AI analyzes</strong> the content</li>
                  <li><strong>Results appear</strong> automatically</li>
                </ol>
              </div>

              <div className="tech-card">
                <h3 className="tech-title">Tech Stack</h3>
                <div className="tech-tags">
                  {['OpenAI GPT-4o','x402 Protocol','Algorand TestNet','USDC','Hono','React 19'].map(t => (
                    <span key={t} className="tech-tag">{t}</span>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>

      {/* ── Payment Modal ── */}
      {modalOpen && (
        <PaymentModal
          req={payReq}
          qr={qrData}
          qrErr={qrErr}
          phase={phase}
          pollNum={pollNum}
          modalError={modalError}
          onClose={handleCloseModal}
          onRetry={handleAnalyze}
          onCheckNow={handleCheckNow}
        />
      )}

      <footer className="app-footer">
        <p>RiskGuard AI · Pay-per-analysis via x402 · Algorand TestNet · USDC</p>
      </footer>
    </div>
  );
}

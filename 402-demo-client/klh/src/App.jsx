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
// onCheckNow is intentionally removed — no manual payment confirmation button.
// Payment verification is automatic only, based on Algorand blockchain polling.
function PaymentModal({ req, qr, qrErr, phase, pollNum, modalError, onClose, onRetry }) {
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

        {/* Status strip — automatic detection only, no manual button */}
        <div className="auto-detect-strip">
          {phase === 'success' ? (
            <div className="auto-detect-success">✅ Payment verified — loading results…</div>
          ) : phase === 'analyzing' ? (
            <div className="auto-detect-checking">
              <span className="spinner-inline" />
              🤖 AI analyzing risk — please wait…
            </div>
          ) : phase === 'verifying' ? (
            <div className="auto-detect-checking">
              <span className="spinner-inline" />
              🔍 Checking Algorand blockchain{pollNum > 0 ? ` (check #${pollNum})` : ''}…
            </div>
          ) : phase === 'waiting' ? (
            <div className="auto-detect-waiting">
              <span className="pulse-dot" />
              ⏳ Waiting for USDC payment{pollNum > 0 ? ` · check #${pollNum}` : ''} · auto-checking every {POLL_INTERVAL_MS/1000}s
            </div>
          ) : phase === 'error' ? (
            <div className="auto-detect-error">
              ❌ {modalError || 'Payment not detected. Please complete the USDC payment and try again.'}
            </div>
          ) : (
            <div className="auto-detect-waiting">
              <span className="pulse-dot" />
              ⏳ Waiting for USDC payment on Algorand TestNet…
            </div>
          )}
        </div>

        {/* Actions — no manual "I have paid" button */}
        <div className="modal-actions">
          {phase === 'error' ? (
            /* Error: only allow full restart (new startedAt) or cancel */
            <><button className="btn btn-primary" onClick={onRetry}>Restart Payment</button>
              <button className="btn btn-ghost"  onClick={onClose}>Cancel</button></>
          ) : (
            /* Waiting/verifying/analyzing: only allow cancel */
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          )}
        </div>

        <p className="modal-footer-note">
          Payment is detected automatically from the Algorand blockchain every {POLL_INTERVAL_MS/1000}s.
          Complete your USDC payment and results will appear automatically.
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
  const stopRef        = useRef(false);   // set true to kill the poll loop
  const timerRef       = useRef(null);
  const contentRef     = useRef('');
  const startedAtRef   = useRef(0);
  const amountRef      = useRef(10000);
  const sessionIdRef   = useRef(0);       // incremented per Analyze click — prevents old sessions

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
      setModalError('Payment not detected after 5 minutes. Please complete the USDC payment and try again, or click "Restart Payment".');
      stopRef.current = true;
      return;
    }

    setPollNum(attemptNum + 1);
    setPhase('verifying');

    // Use the session's exact startedAt — never drift backwards to avoid
    // picking up transactions from previous sessions
    const lookbackStart = startedAtRef.current;
    const mySession = sessionIdRef.current;

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

      // If a new session started while we were awaiting, discard this result
      if (stopRef.current || sessionIdRef.current !== mySession) return;

      if (!resp.ok && resp.status !== 502) {
        // server error — keep polling (don't stop on transient errors)
        setPhase('waiting');
        timerRef.current = setTimeout(() => checkOnce(attemptNum + 1), POLL_INTERVAL_MS);
        return;
      }

      const data = await resp.json();
      if (stopRef.current || sessionIdRef.current !== mySession) return;

      if (data.paid === true) {
        // ── Payment confirmed on-chain ──
        stopPolling();

        if (data.results) {
          // ✅ Payment verified + AI analysis complete
          console.log(`[PAYMENT] Payment verified ✓ txID=${data.transaction_id} — showing results`);
          setModalOpen(false);
          setPhase('idle');
          setResults(data.results);
        } else {
          // Payment confirmed but AI failed (502)
          setModalError(data.error || 'Payment verified, but AI analysis failed. Click "Restart Payment" to try again.');
          setPhase('error');
        }
        return;
      }

      // Not yet paid — schedule next poll
      setPhase('waiting');
      timerRef.current = setTimeout(() => checkOnce(attemptNum + 1), POLL_INTERVAL_MS);

    } catch (err) {
      if (stopRef.current || sessionIdRef.current !== mySession) return;
      console.warn('[Poll] error:', err.message);
      setPhase('waiting');
      timerRef.current = setTimeout(() => checkOnce(attemptNum + 1), POLL_INTERVAL_MS);
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

    // New session — invalidate any previous poll state
    stopPolling();
    sessionIdRef.current += 1;

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

        // Record this session's start time — polling will ONLY look for
        // transactions that occurred after this moment
        startedAtRef.current = Date.now();
        amountRef.current    = rawAmt ? Number(rawAmt) : 10000;

        setPayReq(decoded);
        setModalOpen(true);
        setPhase('idle');
        setQrData(null);
        setQrErr('');
        setModalError('');
        setBusy(false);

        // Generate QR
        try {
          const uri = buildAlgorandURI(decoded);
          setQrData(await makeQR(uri || hdr));
        } catch { setQrErr('Could not generate QR. Pay using the address below.'); }

        // Begin blockchain polling for THIS session's startedAt
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
    // Don't clear verifiedTxRef — user might re-open and retry AI
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  function handleReset() {
    stopPolling();
    sessionIdRef.current += 1;     // invalidate any in-flight polls
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
        />
      )}

      <footer className="app-footer">
        <p>RiskGuard AI · Pay-per-analysis via x402 · Algorand TestNet · USDC</p>
      </footer>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { OverlayEvent } from '../../../shared/types.js';
import { kbd } from '../../shared/kbd.js';

interface AnswerState {
  requestId: number | null;
  question: string | null;
  questionTsMs: number | null;
  skeleton: string[];
  answerTokens: string[];
  firstTokenMs: number | null;
  doneMs: number | null;
  streaming: boolean;
  error: { stage: 'skeleton' | 'answer'; message: string } | null;
}

const initialState: AnswerState = {
  requestId: null,
  question: null,
  questionTsMs: null,
  skeleton: [],
  answerTokens: [],
  firstTokenMs: null,
  doneMs: null,
  streaming: false,
  error: null,
};

interface Toast {
  id: number;
  level: 'info' | 'success' | 'error';
  message: string;
}

export function App(): JSX.Element {
  const [state, setState] = useState<AnswerState>(initialState);
  const [armed, setArmed] = useState(false);
  const [protectedFromShare, setProtectedFromShare] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  useEffect(() => {
    window.api.overlayGetProtection().then(setProtectedFromShare).catch(() => {});
    const unsub = window.api.onOverlayEvent((event: OverlayEvent) => {
      switch (event.kind) {
        case 'armed':
          setArmed(event.armed);
          break;
        case 'protection':
          setProtectedFromShare(event.enabled);
          break;
        case 'toast': {
          const id = ++toastIdRef.current;
          setToasts((prev) => [...prev, { id, level: event.level, message: event.message }]);
          const lifetime = event.level === 'error' ? 6000 : event.level === 'success' ? 4200 : 2600;
          setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
          }, lifetime);
          break;
        }
        case 'question':
          setState({
            requestId: event.requestId,
            question: event.text,
            questionTsMs: event.tStartMs,
            skeleton: [],
            answerTokens: [],
            firstTokenMs: null,
            doneMs: null,
            streaming: false,
            error: null,
          });
          break;
        case 'skeleton':
          setState((prev) =>
            prev.requestId === event.requestId
              ? {
                  ...prev,
                  skeleton: event.bullets,
                  firstTokenMs: event.firstTokenMs,
                  streaming: true,
                }
              : prev,
          );
          break;
        case 'answerToken':
          setState((prev) =>
            prev.requestId === event.requestId
              ? { ...prev, answerTokens: [...prev.answerTokens, event.token], streaming: true }
              : prev,
          );
          break;
        case 'answerDone':
          setState((prev) =>
            prev.requestId === event.requestId
              ? { ...prev, streaming: false, doneMs: event.totalMs }
              : prev,
          );
          break;
        case 'error':
          setState((prev) =>
            prev.requestId === event.requestId
              ? {
                  ...prev,
                  streaming: false,
                  error: { stage: event.stage, message: event.message },
                }
              : prev,
          );
          break;
        case 'reset':
          setState(initialState);
          break;
      }
    });
    return () => unsub();
  }, []);

  const hasQuestion = !!state.question;
  const hasAnswer = state.answerTokens.length > 0;

  return (
    <div className={`overlay${protectedFromShare ? '' : ' unprotected'}`}>
      <StatusStrip armed={armed} state={state} protectedFromShare={protectedFromShare} />
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.level}`}>
              {t.message}
            </div>
          ))}
        </div>
      )}
      <div className="body">
        {!hasQuestion ? (
          <IdleState armed={armed} />
        ) : hasAnswer ? (
          <TeleprompterAnswer
            key={state.requestId}
            tokens={state.answerTokens}
            streaming={state.streaming}
          />
        ) : (
          <WaitingForAnswer question={state.question!} skeleton={state.skeleton} />
        )}
        {state.error && (
          <div className="overlay-error">
            <span className="mono dim">{state.error.stage}:</span>{' '}
            {state.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusStrip({
  armed,
  state,
  protectedFromShare,
}: {
  armed: boolean;
  state: AnswerState;
  protectedFromShare: boolean;
}): JSX.Element {
  return (
    <div className="drag">
      <span className={`rec ${armed ? 'rec-on' : 'rec-idle'}`} />
      <span className="strip-label">{armed ? 'listening' : 'idle'}</span>
      {state.firstTokenMs != null && (
        <span className="mono latency">first token {state.firstTokenMs}ms</span>
      )}
      {state.question && (
        <span className="strip-question" title={state.question}>
          &ldquo;{state.question}&rdquo;
        </span>
      )}
      <span className="drag-spacer" />
      <span className="mono hints">
        {kbd('R')} regen · {kbd('S')} shorter · {kbd('L')} longer · {kbd('I')} snap · {kbd('U')} source · {kbd('V')} hide
      </span>
      <button
        className={`strip-btn shield ${protectedFromShare ? 'shield-on' : 'shield-off'}`}
        onClick={() => window.api.overlayToggleProtection()}
        title={
          protectedFromShare
            ? `Whole app hidden from screen share (${kbd('V')}). Click to make visible.`
            : `VISIBLE on screen share — both windows (${kbd('V')}). Click to hide.`
        }
      >
        {protectedFromShare ? '◉' : '◎'}
      </button>
      <button
        className="strip-btn regen"
        onClick={() => window.api.overlayRegenerate()}
        title={`Regenerate (${kbd('R')})`}
        disabled={!state.question}
      >
        ↻
      </button>
    </div>
  );
}

function IdleState({ armed }: { armed: boolean }): JSX.Element {
  return (
    <div className="idle">
      <span className="idle-mark">{armed ? '◉' : '◯'}</span>
      <span className="idle-copy">
        {armed
          ? 'Listening. When a question is detected, a grounded answer will appear here.'
          : 'Click Start listening in the setup window, then this overlay shows the answer.'}
      </span>
    </div>
  );
}

function WaitingForAnswer({
  question,
  skeleton,
}: {
  question: string;
  skeleton: string[];
}): JSX.Element {
  return (
    <div className="waiting">
      <div className="waiting-question">&ldquo;{question}&rdquo;</div>
      {skeleton.length > 0 ? (
        <ul className="waiting-skel">
          {skeleton.map((b, i) => (
            <li key={i} style={{ animationDelay: `${i * 60}ms` }}>
              · {b}
            </li>
          ))}
        </ul>
      ) : (
        <div className="waiting-dots mono">preparing answer</div>
      )}
    </div>
  );
}

function TeleprompterAnswer({
  tokens,
  streaming,
}: {
  tokens: string[];
  streaming: boolean;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pressedRef = useRef(false);
  const directionRef = useRef(0);
  const lastTsRef = useRef(0);
  const [overflowState, setOverflowState] = useState({ has: false, atBottom: true, atTop: true });

  // Check overflow + scroll position any time content or size changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      const has = el.scrollHeight > el.clientHeight + 2;
      const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 2;
      const atTop = el.scrollTop <= 2;
      setOverflowState({ has, atBottom, atTop });
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, [tokens.length]);

  // Hold-Space / hold-Down / hold-PageDown for continuous scroll. Arrow/Page up for reverse.
  useEffect(() => {
    const SCROLL_KEYS_DOWN = new Set(['Space', 'ArrowDown', 'PageDown']);
    const SCROLL_KEYS_UP = new Set(['ArrowUp', 'PageUp']);
    const PIXELS_PER_MS = 0.055; // ~55 px/sec — comfortable reading pace

    const step = (ts: number) => {
      const el = scrollRef.current;
      if (!el || !pressedRef.current) {
        rafRef.current = null;
        return;
      }
      const dt = lastTsRef.current ? ts - lastTsRef.current : 16;
      lastTsRef.current = ts;
      el.scrollTop += directionRef.current * PIXELS_PER_MS * dt;
      rafRef.current = requestAnimationFrame(step);
    };

    const startScroll = (dir: 1 | -1) => {
      if (pressedRef.current && directionRef.current === dir) return;
      pressedRef.current = true;
      directionRef.current = dir;
      lastTsRef.current = 0;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(step);
      }
    };

    const stopScroll = () => {
      pressedRef.current = false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't scroll while typing in any input — n/a for this overlay, but safe.
      if (SCROLL_KEYS_DOWN.has(e.code)) {
        e.preventDefault();
        if (!e.repeat) startScroll(1);
      } else if (SCROLL_KEYS_UP.has(e.code)) {
        e.preventDefault();
        if (!e.repeat) startScroll(-1);
      } else if (e.code === 'Home') {
        e.preventDefault();
        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (e.code === 'End') {
        e.preventDefault();
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (SCROLL_KEYS_DOWN.has(e.code) || SCROLL_KEYS_UP.has(e.code)) {
        stopScroll();
      }
    };

    const onBlur = () => stopScroll();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pressedRef.current = false;
    };
  }, []);

  const showMoreHint = overflowState.has && !overflowState.atBottom;
  const showAboveHint = overflowState.has && !overflowState.atTop;

  return (
    <div className="teleprompter-wrap">
      <div className="teleprompter" ref={scrollRef} tabIndex={0}>
        <div className="teleprompter-inner">
          {tokens.map((tok, i) => (
            <span key={i} className="tp-token">
              {tok}
            </span>
          ))}
          {streaming && <span className="caret" />}
        </div>
      </div>
      {showAboveHint && <div className="tp-fade tp-fade-top" aria-hidden />}
      {showMoreHint && (
        <>
          <div className="tp-fade tp-fade-bottom" aria-hidden />
          <div className="tp-hint mono">↓ hold space to scroll</div>
        </>
      )}
    </div>
  );
}

import WebSocket from 'ws';
import { resolveApiKey } from '../src/main/apiKey.js';

const URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

async function main() {
  const resolved = await resolveApiKey();
  if (!resolved) {
    console.error('no api key available');
    process.exit(2);
  }
  console.log(`using key from: ${resolved.source}`);

  const ws = new WebSocket(URL, {
    headers: {
      Authorization: `Bearer ${resolved.key}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  const timer = setTimeout(() => {
    console.error('timeout (no events in 10s)');
    ws.close();
    process.exit(1);
  }, 10000);

  ws.on('open', () => {
    console.log('ws OPEN');
    ws.send(JSON.stringify({
      type: 'transcription_session.update',
      session: {
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'gpt-4o-mini-transcribe',
          language: 'en',
          prompt: 'University admissions interview. English. Topics: economics, business, leadership.',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        },
      },
    }));
  });

  let updatedSeen = false;

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    const t = msg.type;
    console.log(`<- ${t}`);
    if (t === 'transcription_session.created' || t === 'session.created') {
      console.log('  session established');
    }
    if (t === 'transcription_session.updated' || t === 'session.updated') {
      updatedSeen = true;
      console.log('  session config accepted ✓');
      clearTimeout(timer);
      setTimeout(() => { ws.close(); }, 100);
    }
    if (t === 'error') {
      console.error('  ERROR:', JSON.stringify(msg.error, null, 2));
      clearTimeout(timer);
      ws.close();
      process.exit(1);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`ws CLOSE ${code} ${reason?.toString()}`);
    process.exit(updatedSeen ? 0 : 1);
  });
  ws.on('error', (err) => {
    console.error('ws ERROR:', err.message);
    process.exit(1);
  });
}

main();

// 짱구 어시스턴트 - 태블릿 웹앱
// 상태: off(시작 전) → idle(호출어 대기) → command(명령 듣는 중) → thinking → speaking → idle

const $ = (id) => document.getElementById(id);
const WAKE = /(짱|장|쨩|쟝)\s?(구|꾸)(야|아|양)?/;
const COMMAND_TIMEOUT = 7000;

let state = 'off';
const history = [];   // 최근 대화 [{role, text}]

function setState(s, msg) {
  state = s;
  document.body.dataset.state = s;
  const defaults = {
    idle: wantMusic ? '음악 듣는 중 · 화면을 누르면 들을게요' : '"짱구야" 하고 불러주세요',
    command: '듣고 있어요…',
    thinking: '생각 중…',
    speaking: '',
    off: '마이크 꺼짐',
  };
  $('status').textContent = msg ?? defaults[s] ?? '';
}

// ─── 시계 ───
function tick() {
  const d = new Date();
  $('time').textContent = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/^(오전|오후)\s*/, '$1 ');
  $('date').textContent = d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
}
tick();
setInterval(tick, 1000);

// ─── 효과음 ───
let audioCtx;
function beep(freqs = [880, 1320]) {
  try {
    audioCtx ||= new AudioContext();
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.16);
      t += 0.11;
    }
  } catch {}
}

// ─── 유튜브 플레이어 ───
// 안드로이드 크롬은 음성인식이 (재)시작될 때마다 다른 소리를 일시정지시킨다.
// 그래서 음악을 트는 동안(wantMusic)은 상시 음성인식을 끄고, 화면을 눌러야 듣는다.
let player, playerReady = false;
let queue = [], qi = 0;
let volume = 70;
let wantMusic = false;     // 사용자가 음악이 나오길 원하는 상태
let resumeMusic = false;   // 명령을 듣느라 잠깐 멈춘 음악을 끝나고 다시 틀지
let ignorePauseUntil = 0;  // 곡을 바꿀 때 잠깐 오는 PAUSED 는 사용자가 멈춘 게 아니다

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('yt', {
    playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: () => { playerReady = true; player.setVolume(volume); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) playIndex(qi + 1);
        // 플레이어 화면에서 직접 멈추거나 튼 경우
        if (state === 'idle' && e.data === YT.PlayerState.PAUSED && wantMusic && Date.now() > ignorePauseUntil) {
          wantMusic = false;
          syncListening();
        }
        if (state === 'idle' && e.data === YT.PlayerState.PLAYING && !wantMusic) { wantMusic = true; syncListening(); }
        updatePlayerUi();
      },
      onError: () => playIndex(qi + 1),   // 퍼가기 금지 영상 등은 건너뜀
    },
  });
};

function playIndex(i) {
  if (!playerReady || !queue.length) return;
  if (i >= queue.length || i < 0) { stopPlayer(); return; }
  qi = i;
  wantMusic = true;
  ignorePauseUntil = Date.now() + 3000;
  player.loadVideoById(queue[qi].videoId);
  player.setVolume(state === 'idle' ? volume : duckLevel());
  $('right').classList.remove('empty');
  document.body.classList.add('playing');
  $('now').textContent = `▶ ${queue[qi].title}`;
}

function stopPlayer() {
  if (playerReady) player.stopVideo();
  queue = [];
  wantMusic = false;
  syncListening();
  $('right').classList.add('empty');
  document.body.classList.remove('playing');
  $('now').textContent = '';
}

function isPlaying() {
  return playerReady && player.getPlayerState?.() === YT.PlayerState.PLAYING;
}

function nowPlaying() {
  if (!queue.length) return null;
  const st = player?.getPlayerState?.();
  return { title: queue[qi].title, state: st === YT.PlayerState.PAUSED ? '일시정지' : '재생 중' };
}

function updatePlayerUi() {
  const st = player?.getPlayerState?.();
  $('ptoggle').textContent = st === YT.PlayerState.PLAYING ? '⏸' : '▶';
}

const duckLevel = () => Math.min(volume, 12);
function duck() { if (playerReady && queue.length) player.setVolume(duckLevel()); }
function unduck() { if (playerReady && queue.length) player.setVolume(volume); }

function control(action) {
  if (!playerReady) return;
  switch (action) {
    case 'pause': wantMusic = false; player.pauseVideo(); break;
    case 'resume': wantMusic = true; player.playVideo(); break;
    case 'toggle': wantMusic = !wantMusic; wantMusic ? player.playVideo() : player.pauseVideo(); break;
    case 'stop': stopPlayer(); break;
    case 'next': playIndex(qi + 1); break;
    case 'previous': playIndex(qi - 1); break;
    case 'volume_up': volume = Math.min(100, volume + 15); player.setVolume(volume); break;
    case 'volume_down': volume = Math.max(5, volume - 15); player.setVolume(volume); break;
  }
  syncListening();
}

document.querySelectorAll('#pbtns button').forEach((b) => b.addEventListener('click', () => control(b.dataset.act)));

// ─── 말하기 (TTS) ───
let koVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('ko'));
  koVoice = vs.find((v) => /google/i.test(v.name)) || vs[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text) {
  return new Promise((resolve) => {
    if (!text || !('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    if (koVoice) u.voice = koVoice;
    u.rate = 1.05;
    // 일부 안드로이드에서 onend 가 안 오는 경우 대비
    const guard = setTimeout(resolve, 2500 + text.length * 180);
    u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
    speechSynthesis.speak(u);
  });
}

// ─── 듣기 (음성 인식) ───
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recOn = false, wantRec = false;
let commandTimer = null;

function initRecognition() {
  if (!SR) {
    setState('off', '이 브라우저는 음성 인식을 지원하지 않아요 (크롬 사용)');
    return false;
  }
  rec = new SR();
  rec.lang = 'ko-KR';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.trim();
      if (e.results[i].isFinal) onFinal(t);
      else interim += t;
    }
    if (!interim) return;
    if (state === 'idle' && WAKE.test(interim)) duck();   // 호출어가 들리면 바로 소리 줄이기
    if (state === 'command' || (state === 'idle' && WAKE.test(interim))) $('you').textContent = interim;
  };

  rec.onend = () => {
    recOn = false;
    if (wantRec) setTimeout(startRec, 200);
  };

  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      wantRec = false;
      setState('off', '마이크 권한이 없어요. 주소창 옆 설정에서 마이크를 허용해 주세요');
    }
  };
  return true;
}

function startRec() {
  if (!rec || !wantRec || recOn) return;
  try { rec.start(); recOn = true; } catch {}
}
function pauseRec() {
  wantRec = false;
  try { rec?.abort(); } catch {}
}
function resumeRec() {
  wantRec = true;
  startRec();
}

function onFinal(text) {
  if (!text) return;
  if (state === 'command') {
    clearTimeout(commandTimer);
    const m = text.match(WAKE);   // "짱구야 ... " 를 또 말한 경우 호출어 제거
    const cmd = m ? text.slice(m.index + m[0].length) : text;
    ask(clean(cmd) || text);
    return;
  }
  if (state !== 'idle') return;
  const m = text.match(WAKE);
  if (!m) { unduck(); return; }
  const rest = clean(text.slice(m.index + m[0].length));
  if (rest.length >= 2) ask(rest);
  else listenForCommand();
}

const clean = (s) => s.replace(/^[\s,.!?~]+|[\s,.!?~]+$/g, '');

function listenForCommand() {
  setState('command');
  if (wantMusic && playerReady) {
    // 음성인식이 어차피 음악을 멈추므로 미리 멈추고, 끝나면 다시 튼다
    resumeMusic = true;
    player.pauseVideo();
  }
  resumeRec();
  beep();
  $('you').textContent = '';
  clearTimeout(commandTimer);
  commandTimer = setTimeout(() => { if (state === 'command') backToIdle(); }, COMMAND_TIMEOUT);
}

function backToIdle() {
  unduck();
  if (resumeMusic) {
    resumeMusic = false;
    if (wantMusic && playerReady && !isPlaying()) {
      ignorePauseUntil = Date.now() + 3000;
      player.playVideo();
    }
  }
  setState('idle');
  syncListening();
}

// 대기 상태에서: 음악이 나오면 상시 음성인식을 끄고, 아니면 켠다
function syncListening() {
  if (state !== 'idle') return;
  if (wantMusic) pauseRec();
  else resumeRec();
  setState('idle');
}

// ─── 질문 처리 ───
async function ask(text) {
  clearTimeout(commandTimer);
  pauseRec();
  duck();
  $('you').textContent = text;
  $('bot').textContent = '';
  setState('thinking');

  const out = await chat({ text, history, nowPlaying: nowPlaying() });

  history.push({ role: 'user', text });
  if (out.reply) history.push({ role: 'model', text: out.reply });
  while (history.length > 12) history.shift();

  // 정지·일시정지는 말하기 전에 바로 실행
  const controls = (out.actions || []).filter((a) => a.type === 'control');
  const play = (out.actions || []).find((a) => a.type === 'play');
  for (const c of controls) control(c.action);

  $('bot').textContent = out.reply || '';
  if (out.reply) {
    setState('speaking');
    await speak(out.reply);
  }

  if (play) {
    queue = play.videos;
    qi = 0;
    volume = Math.max(volume, 30);
    playIndex(0);
  }
  backToIdle();
}

// ─── 시작 ───
// 마이크 버튼뿐 아니라 왼쪽 화면(시계·대화) 어디를 눌러도 듣기 시작
$('left').addEventListener('click', (e) => {
  if (e.target.closest('#typebox')) return;
  if (state === 'command') { backToIdle(); return; }
  if (state === 'idle' || state === 'off') listenForCommand();
});

$('typebox').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('typein').value.trim();
  if (!t) return;
  $('typein').value = '';
  $('typein').blur();
  ask(t);
});

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state !== 'off') { keepAwake(); syncListening(); }
});

// ─── 설정 화면 ───
function openSettings() {
  const s = loadSettings();
  for (const k of ['geminiKey', 'youtubeKey', 'model', 'homeName', 'homeLat', 'homeLon']) $(`set-${k}`).value = s[k];
  $('settings').classList.remove('hidden');
}

$('gear').addEventListener('click', openSettings);
$('set-cancel').addEventListener('click', () => $('settings').classList.add('hidden'));
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = (k) => $(`set-${k}`).value.trim();
  saveSettings({
    geminiKey: v('geminiKey'),
    youtubeKey: v('youtubeKey'),
    model: v('model'),
    homeName: v('homeName') || DEFAULTS.homeName,
    homeLat: Number(v('homeLat')) || DEFAULTS.homeLat,
    homeLon: Number(v('homeLon')) || DEFAULTS.homeLon,
  });
  $('settings').classList.add('hidden');
});

$('start').addEventListener('click', () => {
  $('start').classList.add('hidden');
  if (!loadSettings().geminiKey) openSettings();
  refreshHomeWeather();
  setInterval(refreshHomeWeather, HOME_WEATHER_TTL);
  // 사용자 터치 안에서 오디오·TTS 잠금 해제
  audioCtx ||= new AudioContext();
  audioCtx.resume();
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake();
  if (initRecognition()) {
    setState('idle');
    resumeRec();
  }
});

setState('off', '');

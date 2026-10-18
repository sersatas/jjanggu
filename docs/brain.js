// 짱구의 두뇌: Gemini 함수호출로 날씨·유튜브·플레이어 제어 처리 (브라우저에서 직접 호출)

// ─── 설정 (이 태블릿의 localStorage 에만 저장) ───
const SETTINGS_KEY = 'jjanggu.settings';
const DEFAULTS = {
  geminiKey: '',
  youtubeKey: '',
  model: '',   // 비워 두면 MODELS 를 자동으로 사용
  homeName: '서울',
  homeLat: 37.5665,
  homeLon: 126.978,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved.model === 'gemini-3.5-flash-lite') saved.model = '';   // 예전 기본값은 자동으로 전환
    return { ...DEFAULTS, ...saved };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

// ─── 날씨 (Open-Meteo, 키 불필요) ───
const WEATHER_CODES = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '짙은 안개',
  51: '약한 이슬비', 53: '이슬비', 55: '강한 이슬비', 56: '어는 이슬비', 57: '어는 이슬비',
  61: '약한 비', 63: '비', 65: '강한 비', 66: '어는 비', 67: '어는 비',
  71: '약한 눈', 73: '눈', 75: '많은 눈', 77: '싸락눈',
  80: '약한 소나기', 81: '소나기', 82: '강한 소나기', 85: '눈 소나기', 86: '강한 눈 소나기',
  95: '뇌우', 96: '우박 동반 뇌우', 99: '강한 우박 동반 뇌우',
};
const skyDesc = (c) => WEATHER_CODES[c] || `코드 ${c}`;

function dustGrade(pm10, pm25) {
  const g10 = pm10 <= 30 ? 0 : pm10 <= 80 ? 1 : pm10 <= 150 ? 2 : 3;
  const g25 = pm25 <= 15 ? 0 : pm25 <= 35 ? 1 : pm25 <= 75 ? 2 : 3;
  return ['좋음', '보통', '나쁨', '매우 나쁨'][Math.max(g10, g25)];
}

async function getWeather({ place, latitude, longitude } = {}, s) {
  const loc = latitude != null && longitude != null
    ? { name: place || '요청 지역', lat: latitude, lon: longitude }
    : { name: s.homeName, lat: s.homeLat, lon: s.homeLon };
  const q = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon, timezone: 'Asia/Seoul', forecast_days: 7,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
  });
  const aq = new URLSearchParams({ latitude: loc.lat, longitude: loc.lon, timezone: 'Asia/Seoul', current: 'pm10,pm2_5' });
  const [w, a] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?${q}`).then((r) => r.json()),
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${aq}`).then((r) => r.json()).catch(() => null),
  ]);
  if (!w.current) throw new Error('날씨 정보를 가져오지 못했어요');

  // 앞으로 24시간, 3시간 간격
  const now = w.current.time.slice(0, 13);
  const start = Math.max(0, w.hourly.time.findIndex((t) => t.slice(0, 13) >= now));
  const next24h = [];
  for (let i = start; i < start + 24 && i < w.hourly.time.length; i += 3) {
    next24h.push({
      time: w.hourly.time[i].slice(5).replace('T', ' '),
      temp: w.hourly.temperature_2m[i],
      rain_chance: w.hourly.precipitation_probability[i],
      sky: skyDesc(w.hourly.weather_code[i]),
    });
  }
  const c = w.current;
  return {
    place: loc.name,
    now: {
      sky: skyDesc(c.weather_code), temp: c.temperature_2m, feels_like: c.apparent_temperature,
      humidity: c.relative_humidity_2m, precipitation_mm: c.precipitation, wind_kmh: c.wind_speed_10m,
      ...(a?.current ? { pm10: a.current.pm10, pm2_5: a.current.pm2_5, dust: dustGrade(a.current.pm10, a.current.pm2_5) } : {}),
    },
    next24h,
    daily: w.daily.time.map((d, i) => ({
      date: d, sky: skyDesc(w.daily.weather_code[i]),
      min: w.daily.temperature_2m_min[i], max: w.daily.temperature_2m_max[i],
      rain_chance: w.daily.precipitation_probability_max[i], rain_mm: w.daily.precipitation_sum[i],
    })),
  };
}

// 집 날씨는 미리 받아 두고 시스템 프롬프트에 넣는다 → 날씨 질문을 Gemini 한 번 호출로 끝냄
const HOME_WEATHER_TTL = 20 * 60 * 1000;
let homeWeather = null, homeWeatherAt = 0, homeWeatherLoading = null;

function refreshHomeWeather() {
  const s = loadSettings();
  homeWeatherLoading ||= getWeather({}, s)
    .then((w) => { homeWeather = w; homeWeatherAt = Date.now(); })
    .catch((e) => console.warn('집 날씨 갱신 실패', e))
    .finally(() => { homeWeatherLoading = null; });
  return homeWeatherLoading;
}

async function freshHomeWeather() {
  if (Date.now() - homeWeatherAt > HOME_WEATHER_TTL) {
    // 오래됐으면 갱신을 기다리되, 2초 넘게 걸리면 있는 걸로 답한다
    await Promise.race([refreshHomeWeather(), new Promise((r) => setTimeout(r, 2000))]);
  }
  return homeWeather;
}

// ─── 유튜브 검색 ───
function decodeHtml(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

async function searchYoutube(query, s) {
  if (!s.youtubeKey) throw new Error('유튜브 키가 설정되지 않았어요');
  const q = new URLSearchParams({
    part: 'snippet', q: query, type: 'video', videoEmbeddable: 'true',
    maxResults: '8', regionCode: 'KR', relevanceLanguage: 'ko', key: s.youtubeKey,
  });
  const data = await fetch(`https://www.googleapis.com/youtube/v3/search?${q}`).then((r) => r.json());
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map((it) => ({
    videoId: it.id.videoId,
    title: decodeHtml(it.snippet.title),
    channel: decodeHtml(it.snippet.channelTitle),
  }));
}

// ─── Gemini ───
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_weather',
      description: '날씨·기온·비 소식·미세먼지를 조회한다. 현재, 앞으로 24시간(3시간 간격), 7일 예보를 돌려준다. 지역을 말하지 않으면 집 위치로 조회하므로 인자를 비워 둔다.',
      parameters: {
        type: 'object',
        properties: {
          place: { type: 'string', description: '사용자가 말한 지역 이름 (예: 부산, 강남구)' },
          latitude: { type: 'number', description: '그 지역의 위도' },
          longitude: { type: 'number', description: '그 지역의 경도' },
        },
      },
    },
    {
      name: 'play_youtube',
      description: '유튜브에서 노래·영상을 검색해 태블릿에서 바로 재생한다. 검색 결과 여러 개가 순서대로 이어서 재생된다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '유튜브 검색어. 가수/곡명/분위기를 살려서 (예: "아이유 좋은날", "비 오는 날 듣기 좋은 잔잔한 노래 플레이리스트")' },
        },
        required: ['query'],
      },
    },
    {
      name: 'control_player',
      description: '지금 재생 중인 유튜브를 제어한다.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'stop', 'next', 'previous', 'volume_up', 'volume_down'],
            description: 'pause=일시정지 ("멈춰", "잠깐"), resume=다시 재생, stop=완전히 끄기 ("꺼", "그만 틀어"), next=다음 곡, previous=이전 곡, volume_up/down=소리 크게/작게',
          },
        },
        required: ['action'],
      },
    },
  ],
}];

function systemPrompt(s, nowPlaying, home) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short' });
  return [
    '너는 집 거실 태블릿에 사는 음성 비서 "짱구"야. 사용자가 말로 묻고, 너의 대답은 소리 내어 읽힌다.',
    '- 친근한 존댓말(해요체)로, 1~3문장으로 짧게 말해. 마크다운·이모지·목록 기호·괄호 설명은 쓰지 마.',
    '- 숫자는 읽기 좋게 말해 (예: 18.4°C → 18도).',
    '- 음성 인식 결과라 오타나 비슷한 발음이 섞여 있을 수 있어. 문맥으로 의도를 추측해서 처리하고, 정말 모르겠을 때만 되물어.',
    '- 노래·음악·영상을 틀어달라는 말이면 반드시 play_youtube 를 호출해야 실제로 재생된다. 호출하지 않고 "틀어드릴게요" 라고만 말하면 안 된다. 재생할 땐 "○○ 틀어드릴게요" 정도로 아주 짧게 말해.',
    '- 멈춰/꺼/다음 곡/소리 줄여 같은 말은 control_player 를 쓴다. 이때 대답은 "네" 정도로 아주 짧게, 혹은 비워도 된다.',
    home
      ? `- 날씨·우산·옷차림·미세먼지 질문: 지역을 말하지 않았거나 ${s.homeName}이면 아래 "집 날씨" 데이터로 바로 답하고 get_weather 는 부르지 마. 다른 지역일 때만 get_weather 를 쓴다. 묻는 것에 맞춰 핵심만 말해.`
      : '- 날씨·우산·옷차림·미세먼지 질문은 get_weather 결과로 답한다. 묻는 것에 맞춰 핵심만 말해.',
    '- 그 밖의 상식·지식 질문은 네 지식으로 간단히 답해. 날짜·숫자처럼 정확해야 하는데 확실하지 않으면 그렇다고 말해.',
    `- 집 위치: ${s.homeName}. 현재 시각: ${now}.`,
    nowPlaying ? `- 지금 재생 중: "${nowPlaying.title}" (${nowPlaying.state})` : '- 지금 재생 중인 영상 없음.',
    ...(home ? ['', `집 날씨 (${s.homeName}):`, JSON.stringify({ now: home.now, next24h: home.next24h, daily: home.daily.slice(0, 5) })] : []),
  ].join('\n');
}

class QuotaError extends Error {}

// 모델마다 붐비는 정도가 수시로 바뀐다. 첫 모델이 HEDGE_DELAY 안에 답하지 않으면 다음 모델에도
// 동시에 물어보고 먼저 온 답을 쓴다. 무료 한도도 모델별로 따로라 한도 초과 때도 다음 모델로 간다.
// 순서 = 하루 무료 한도가 넉넉한 것부터 (gemini-3.6-flash 는 하루 20회뿐이라 마지막)
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
const HEDGE_DELAY = 2500;
const GEMINI_TIMEOUT = 15000;
const QUOTA_SKIP = 10 * 60 * 1000;
const quotaHitAt = {};   // 한도에 걸린 모델은 잠시 건너뛴다

const isRetryable = (e) => e instanceof QuotaError || e.retryable || e.name === 'TimeoutError';

async function geminiOnce(model, body, s, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const send = (level) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.geminiKey },
    body: JSON.stringify({ ...body, generationConfig: { thinkingConfig: { thinkingLevel: level } } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(GEMINI_TIMEOUT)]),
  });
  let res = await send('minimal');
  let data = await res.json();
  if (res.status === 400 && /thinking level/i.test(data.error?.message)) {
    res = await send('low');
    data = await res.json();
  }
  if (res.status === 429) {
    quotaHitAt[model] = Date.now();
    throw new QuotaError(data.error?.message || 'quota');
  }
  if (!res.ok) {
    const err = new Error(data.error?.message || `Gemini ${res.status}`);
    err.retryable = res.status >= 500;
    throw err;
  }
  data.model = model;
  return data;
}

// pinned: 같은 질문의 두 번째 호출(도구 결과 전달)은 첫 답을 준 모델로 보낸다 (생각 서명이 모델마다 달라서)
function gemini(body, s, pinned) {
  let models = pinned ? [pinned] : [...new Set([s.model, ...MODELS].filter(Boolean))];
  const available = models.filter((m) => !(Date.now() - (quotaHitAt[m] || 0) < QUOTA_SKIP));
  if (available.length) models = available;
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false, lastErr, timer;
    const controllers = [];

    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controllers.forEach((c) => c.abort());
      fn(v);
    };

    const launch = () => {
      if (done || next >= models.length) return;
      const model = models[next++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      running++;
      const t0 = performance.now();
      geminiOnce(model, body, s, ctrl.signal).then(
        (data) => {
          console.log(`✓ ${model} ${Math.round(performance.now() - t0)}ms`);
          finish(resolve, data);
        },
        (e) => {
          running--;
          if (done) return;
          lastErr = e;
          console.warn(`⚠ ${model}: ${e.message}`);
          if (!isRetryable(e)) return finish(reject, e);
          if (next < models.length) { clearTimeout(timer); launch(); }
          else if (!running) finish(reject, lastErr);
        },
      );
      clearTimeout(timer);
      timer = setTimeout(launch, HEDGE_DELAY);
    };
    launch();
  });
}

// 반환: { reply, actions: [{type:'play', videos}, {type:'control', action}] }
async function chat({ text, history = [], nowPlaying }) {
  const s = loadSettings();
  if (!s.geminiKey) return { reply: '제미나이 키가 아직 설정되지 않았어요. 오른쪽 위 톱니바퀴를 눌러 입력해 주세요.', actions: [] };

  const contents = history.slice(-10).map((h) => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: [{ text }] });
  const actions = [];
  let forcePlay = false;
  let pinned = null;

  try {
    const home = await freshHomeWeather();
    for (let turn = 0; turn < 4; turn++) {
      const data = await gemini({
        systemInstruction: { parts: [{ text: systemPrompt(s, nowPlaying, home) }] },
        contents,
        tools: TOOLS,
        ...(forcePlay && turn === 0
          ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['play_youtube'] } } }
          : {}),
      }, s, pinned);
      if (turn === 0) pinned = data.model;
      const content = data.candidates?.[0]?.content;
      if (!content?.parts) return { reply: '음, 잘 모르겠어요. 다시 말해 주실래요?', actions };
      contents.push(content); // thoughtSignature 보존을 위해 그대로 되돌려 보냄

      const calls = content.parts.filter((p) => p.functionCall);
      const said = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();

      // "틀어드릴게요" 라고만 하고 재생 도구를 안 부른 경우: 재생 도구를 강제해서 다시 묻는다
      if (!calls.length && turn === 0 && !forcePlay && /틀어|재생|들려/.test(text) && /틀어|재생|들려/.test(said)) {
        contents.pop();
        forcePlay = true;
        pinned = null;
        turn--;
        continue;
      }
      if (!calls.length) return { reply: said, actions };

      // 플레이어 제어만 있으면 결과를 다시 물을 필요 없이 바로 끝낸다
      if (calls.every((p) => p.functionCall.name === 'control_player')) {
        for (const p of calls) actions.push({ type: 'control', action: p.functionCall.args.action });
        return { reply: said, actions };
      }

      const responses = [];
      for (const { functionCall: fc } of calls) {
        let result;
        try {
          if (fc.name === 'get_weather') {
            result = await getWeather(fc.args, s);
          } else if (fc.name === 'play_youtube') {
            const videos = await searchYoutube(fc.args.query, s);
            if (videos.length) actions.push({ type: 'play', videos });
            result = videos.length
              ? { playing: videos[0].title, channel: videos[0].channel, queued: videos.length }
              : { error: '검색 결과가 없어요' };
          } else if (fc.name === 'control_player') {
            actions.push({ type: 'control', action: fc.args.action });
            result = { ok: true };
          } else {
            result = { error: `알 수 없는 도구 ${fc.name}` };
          }
        } catch (e) {
          result = { error: e.message };
        }
        console.log(`🔧 ${fc.name}`, fc.args, result);
        responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: result } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { reply: '처리하다가 길을 잃었어요. 다시 말해 주세요.', actions };
  } catch (e) {
    console.error(e);
    if (e instanceof QuotaError) return { reply: '지금 너무 많이 물어봐서 잠깐 쉬어야 해요. 1분 뒤에 다시 말해 주세요.', actions };
    if (/API key|API_KEY|permission|referer/i.test(e.message)) return { reply: '제미나이 키에 문제가 있어요. 설정에서 키를 확인해 주세요.', actions };
    return { reply: '인터넷 연결이나 서버에 문제가 있어요. 잠시 뒤에 다시 말해 주세요.', actions };
  }
}

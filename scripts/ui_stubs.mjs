#!/usr/bin/env node
// Advarr — UI screenshot stub loader (dev/docs tooling, NOT runtime code).
// Activated only via ADVARR_UI_STUBS=1 and `node --import ./scripts/ui_stubs.mjs`.
// Wraps globalThis.fetch so backend calls to api.themoviedb.org return canned
// deterministic data and image.tmdb.org serves generated placeholder posters.
// Zero deps, zero external network → screenshots are reproducible in CI.
// The app itself is untouched (no proxy config, no DNS tricks).
import zlib from 'node:zlib';

if (process.env.ADVARR_UI_STUBS === '1') {
  const realFetch = globalThis.fetch;

  // ---------- deterministic TMDB catalog ----------
  const MOVIES = [
    [1011985, 'Кунг-фу Панда 4', 2024, 7.2], [872906, 'Оппенгеймер', 2023, 8.1],
    [693134, 'Дюна: Часть вторая', 2024, 8.0], [1022789, 'Годзилла и Конг', 2024, 7.0],
    [573435, 'Бэтмен', 2022, 7.5], [447365, 'Стражи Галактики 3', 2023, 7.8],
    [786892, 'Фурия', 2024, 7.6], [933259, 'Богемская рапсодия 2', 2024, 6.9],
    [519182, 'Аквамен 2', 2023, 6.5], [951491, 'План побега', 2024, 6.8],
    [653346, 'Кунг-фу лига', 2024, 6.7], [823464, 'Боб Marley', 2024, 6.6],
  ].map(([id, title, year, rating]) => ({
    id, title, original_title: title, media_type: 'movie',
    release_date: `${year}-02-15`, poster_path: `/p${id}.jpg`, backdrop_path: '',
    overview: `Детерминированное описание для скриншотов — ${title}.`,
    vote_average: rating, vote_count: 4200 + id % 900, popularity: 90 + (id % 40),
    original_language: 'en', genre_ids: [28, 12], adult: false,
  }));
  const SHOWS = [
    [119051, 'Уэнсдей', 2022, 8.0], [237941, 'Падение сокола', 2024, 7.4],
    [94605, 'Аркейн', 2021, 8.6], [1399, 'Игра престолов', 2011, 8.4],
    [125993, 'Медведь', 2022, 8.2], [110492, 'Дом Дракона', 2022, 8.1],
    [93405, 'Игра в кальмара', 2021, 7.7], [82856, 'Мандалорец', 2019, 8.3],
  ].map(([id, name, year, rating]) => ({
    id, name, original_name: name, media_type: 'tv',
    first_air_date: `${year}-03-10`, poster_path: `/p${id}.jpg`, backdrop_path: '',
    overview: `Детерминированное описание для скриншотов — ${name}.`,
    vote_average: rating, vote_count: 3800 + id % 700, popularity: 85 + (id % 45),
    original_language: 'en', genre_ids: [18, 10765], adult: false,
  }));
  const ITEMS = [...MOVIES, ...SHOWS];
  const GENRES = {
    movie: [[28, 'Боевик'], [12, 'Приключения'], [16, 'Мультфильм'], [35, 'Комедия'], [27, 'Ужасы'], [878, 'Фантастика']],
    tv: [[10765, 'Sci-Fi & Fantasy'], [16, 'Анимация'], [18, 'Драма'], [10759, 'Экшен & Приключения'], [9648, 'Детектив']],
  };

  function tmdbResponse(href) {
    const { pathname } = new URL(href);
    if (pathname.endsWith('/configuration')) {
      return { ok: true, status: 200, body: JSON.stringify({ images: { secure_base_url: 'https://image.tmdb.org/t/p' } }) };
    }
    const genreMatch = pathname.match(/^\/3\/genre\/(movie|tv)\/list/);
    if (genreMatch) {
      return { ok: true, status: 200, body: JSON.stringify({ genres: GENRES[genreMatch[1]].map(([id, name]) => ({ id, name })) }) };
    }
    return { ok: true, status: 200, body: JSON.stringify({ page: 1, results: ITEMS, total_pages: 1, total_results: ITEMS.length }) };
  }

  // ---------- generated placeholder posters (1x1 PNG, color by id) ----------
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const pngCache = new Map();
  function posterPng(hex) {
    if (pngCache.has(hex)) return pngCache.get(hex);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 1x1, 8-bit RGB
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    pngCache.set(hex, png);
    return png;
  }
  const PALETTE = ['CC4433', '3377CC', '44AA66', 'CC8833', '7744AA', 'CC3366', '33AA99', 'AA6633'];

  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (href.startsWith('https://image.tmdb.org/')) {
      const m = href.match(/p(\d+)\.jpg/);
      const color = PALETTE[(m ? Number(m[1]) : 0) % PALETTE.length];
      return new Response(posterPng(color), { headers: { 'Content-Type': 'image/png' } });
    }
    if (href.startsWith('https://api.themoviedb.org/')) {
      const stub = tmdbResponse(href);
      return new Response(stub.body, { status: stub.status, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  console.log('[ui_stubs] TMDB + image stubs active (ADVARR_UI_STUBS=1)');
}
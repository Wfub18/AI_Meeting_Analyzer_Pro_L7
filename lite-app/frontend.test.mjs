import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const link = 'https://drive.google.com/file/d/OfflineFixture/view';
const script = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const sections = {
  summary: [{ text: 'Обсудили сроки.', evidence: 'Готово к пятнице.' }],
  decisions: [], tasks: [], questions: [],
};

function meeting(id, options = {}) {
  return {
    id, name: id + '.mp4', addedAt: '2026-11-09T10:00:00Z',
    status: 'ready', phase: null, notes: sections, ...options,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function page(initial = [], imports, upload) {
  let activeElement;
  class Element {
    constructor(tag) { this.tag = tag; }
    children = [];
    dataset = {};
    listeners = {};
    attributes = {};
    classes = new Set();
    classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    textContent = '';
    value = '';
    hidden = false;
    disabled = false;
    files = [];
    append(...children) {
      for (const child of children) child.parentElement = this;
      this.children.push(...children);
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    get childElementCount() { return this.children.length; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(event, handler) { this.listeners[event] = handler; }
    focus() { activeElement = this; }
    querySelectorAll(selector) {
      const match = child => selector === 'button[data-id]'
        ? child.tag === 'button' && child.dataset.id : child.className === 'delete-meeting';
      return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  }

  const elements = {
    video: new Element('input'), 'drive-import': new Element('form'),
    'drive-url': new Element('input'), 'drive-submit': new Element('button'),
    'import-previous': new Element('button'), notice: new Element('p'),
    history: new Element('ul'), empty: new Element('p'), detail: new Element('section'),
  };
  elements['import-previous'].hidden = true;
  const records = new Map(initial.map(record => [record.id, record]));
  const calls = [];
  const timers = [];
  const context = createContext({
    document: {
      querySelector: selector => elements[selector.slice(1)],
      createElement: tag => new Element(tag),
      get activeElement() { return activeElement; },
    },
    window: { confirm: () => true },
    setInterval: (callback, interval) => timers.push({ callback, interval }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/imports' && options?.method === 'POST') return imports(options, records);
      if (url === '/api/meetings' && options?.method === 'POST') return upload(options, records);
      if (url === '/api/meetings') return Response.json([...records.values()]);
      assert.match(url, /^\/api\/meetings\/[^/]+$/);
      const id = url.split('/').at(-1);
      if (options?.method === 'DELETE') {
        records.delete(id);
        return Response.json({ id });
      }
      return records.has(id) ? Response.json(records.get(id)) : Response.json({ error: 'Встреча не найдена.' }, { status: 404 });
    },
  });
  runInContext(script, context);
  const refresh = () => runInContext('refresh()', context);
  await refresh();
  return {
    elements, records, calls, timers, refresh,
    submit: (url = link) => {
      elements['drive-url'].value = url;
      return elements['drive-import'].listeners.submit({ preventDefault() {} });
    },
    title: () => elements.detail.children[0].textContent,
  };
}

test('form is mounted next to the existing upload and gives the Drive field an accessible label', async () => {
  const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<input id="video"[\s\S]*<form id="drive-import"/);
  assert.match(html, /<label for="drive-url">Публичная ссылка Google Drive<\/label>/);
  assert.match(html, /<button id="drive-submit" type="submit">Импортировать<\/button>/);
  assert.match(html, /<button id="import-previous" type="button" hidden>/);
});

test('202 uses the existing history polling and displays the Drive source and analysis result', async () => {
  const processing = meeting('new', { status: 'processing', phase: 'audio', source: 'google-drive', notes: undefined });
  const p = await page([], (options, records) => {
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { url: link });
    records.set(processing.id, processing);
    return Response.json({ id: processing.id }, { status: 202 });
  });
  await p.submit('  ' + link + ' ');
  assert.match(p.elements.notice.textContent, /Файл принят/);
  assert.equal(p.title(), processing.name);
  assert.match(p.elements.detail.children[1].textContent, /Google Drive.*извлечение аудио/);
  assert.match(p.elements.history.children[0].children[0].children[0].textContent, /Google Drive/);
  assert.equal(p.elements['drive-submit'].disabled, true);
  assert.deepEqual(p.timers.map(timer => timer.interval), [1800]);

  p.records.set(processing.id, { ...processing, phase: null, status: 'ready', notes: sections, transcript: 'Готово к пятнице.' });
  p.timers[0].callback();
  await p.refresh();
  assert.equal(p.elements['drive-submit'].disabled, false);
  assert.deepEqual(p.elements.detail.children.filter(node => node.tag === 'h3').map(node => node.textContent), [
    'Краткое содержание', 'Принятые решения', 'Следующие задачи', 'Открытые вопросы', 'Полный транскрипт',
  ]);
  const citation = p.elements.detail.children.find(node => node.tag === 'ul').children[0].children[0];
  assert.equal(citation.children[1].textContent, 'Готово к пятнице.');
});

test('200 opens the existing duplicate without adding a row', async () => {
  const other = meeting('other');
  const existing = meeting('existing', { source: 'google-drive' });
  const p = await page([other, existing], () => Response.json({ id: existing.id, duplicate: true }));
  assert.equal(p.title(), other.name);
  await p.submit();
  assert.match(p.elements.notice.textContent, /уже есть в истории/);
  assert.equal(p.title(), existing.name);
  assert.equal(p.elements.history.childElementCount, 2);
  assert.equal(p.elements['import-previous'].hidden, true);
});

test('409 with an ID offers to open the interrupted meeting without posting again', async () => {
  const other = meeting('other');
  const failed = meeting('previous', { status: 'error', error: 'Обработка прервана.' });
  const p = await page([other, failed], () => Response.json({ id: failed.id, error: 'Повторный вызов не выполнен.' }, { status: 409 }));
  await p.submit();
  assert.match(p.elements.notice.textContent, /предыдущая обработка не завершилась/);
  assert.equal(p.elements.notice.classes.has('problem'), true);
  assert.equal(p.elements['import-previous'].hidden, false);
  assert.equal(p.title(), other.name);
  await p.elements['import-previous'].listeners.click();
  assert.equal(p.title(), failed.name);
  assert.equal(p.calls.filter(call => call.options?.method === 'POST').length, 1);
});

test('reports invalid links, server errors and a busy 409 without a previous meeting', async () => {
  const replies = [
    Response.json({ error: 'Недопустимая ссылка.' }, { status: 400 }),
    Response.json({ error: 'Ошибка сохранения.' }, { status: 500 }),
    Response.json({ error: 'Дождитесь завершения.' }, { status: 409 }),
    new Response('<html>', { status: 502 }),
  ];
  const p = await page([], () => replies.shift());
  await p.submit('');
  assert.match(p.elements.notice.textContent, /Введите публичную ссылку/);
  assert.equal(p.calls.filter(call => call.url === '/api/imports').length, 0);
  for (const [expected, hint] of [
    [/Недопустимая ссылка/, true], [/Ошибка сохранения/, false],
    [/Дождитесь завершения/, false], [/Не удалось импортировать/, false],
  ]) {
    await p.submit('https://example.test/not-drive');
    assert.match(p.elements.notice.textContent, expected);
    assert.equal(p.elements.notice.textContent.includes('ручную загрузку'), hint);
    assert.equal(p.elements.notice.classes.has('problem'), true);
    assert.equal(p.elements['import-previous'].hidden, true);
    assert.equal(p.elements['drive-submit'].disabled, false);
  }
});

test('keeps both submission controls locked while the import downloads and verifies', async () => {
  const gate = deferred();
  const p = await page([], async (options, records) => {
    records.set('working', meeting('working', { status: 'processing', phase: 'download', source: 'google-drive' }));
    return gate.promise;
  });
  const pending = p.submit();
  assert.match(p.elements.notice.textContent, /Скачивание и проверка/);
  await p.refresh();
  assert.match(p.elements.detail.children[1].textContent, /скачивание и проверка/);
  assert.equal(p.elements['drive-submit'].disabled, true);
  assert.equal(p.elements['drive-url'].disabled, true);
  assert.equal(p.elements.video.disabled, true);
  await p.submit();
  p.elements.video.files = [{ name: 'manual.mp4', size: 1024 }];
  await p.elements.video.listeners.change();
  assert.equal(p.calls.filter(call => call.options?.method === 'POST').length, 1);
  p.records.delete('working');
  gate.resolve(Response.json({ error: 'Загрузка не завершилась.' }, { status: 422 }));
  await pending;
  assert.match(p.elements.notice.textContent, /Загрузка не завершилась.*ручную загрузку/);
  assert.equal(p.elements['drive-submit'].disabled, false);
  assert.equal(p.elements.video.disabled, false);
});

test('manual MP4 upload still opens the history result and it can be deleted', async () => {
  const uploaded = meeting('manual', { source: 'upload' });
  const file = { name: 'Моя встреча.mp4', size: 1024 };
  const p = await page([], undefined, (options, records) => {
    assert.equal(options.headers['X-File-Name'], encodeURIComponent(file.name));
    assert.equal(options.body, file);
    records.set(uploaded.id, uploaded);
    return Response.json({ id: uploaded.id }, { status: 202 });
  });
  p.elements.video.files = [file];
  await p.elements.video.listeners.change();
  assert.equal(p.title(), uploaded.name);
  assert.equal(p.elements.history.childElementCount, 1);
  assert.match(p.elements.detail.children[1].textContent, /Загружено вручную/);
  assert.match(p.elements.history.children[0].children[0].children[0].textContent, /Загружено вручную/);
  assert.doesNotMatch(p.elements.detail.children[1].textContent, /Google Drive/);
  await p.elements.history.children[0].children[1].listeners.click();
  assert.equal(p.elements.history.childElementCount, 0);
  assert.equal(p.title(), 'Результат');
  assert.ok(p.calls.some(call => call.url === '/api/meetings/manual' && call.options?.method === 'DELETE'));
});

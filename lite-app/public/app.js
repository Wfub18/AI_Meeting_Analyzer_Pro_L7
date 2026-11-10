const video = document.querySelector('#video');
const importForm = document.querySelector('#drive-import');
const driveUrl = document.querySelector('#drive-url');
const driveSubmit = document.querySelector('#drive-submit');
const previousButton = document.querySelector('#import-previous');
const notice = document.querySelector('#notice');
const history = document.querySelector('#history');
const empty = document.querySelector('#empty');
const detail = document.querySelector('#detail');
const labels = { processing: 'Обрабатывается', ready: 'Готово', error: 'Ошибка' };
const phases = { download: 'скачивание и проверка видео', audio: 'извлечение аудио', transcription: 'распознавание речи', notes: 'составление конспекта' };
const sections = { summary: 'Краткое содержание', decisions: 'Принятые решения', tasks: 'Следующие задачи', questions: 'Открытые вопросы' };
const date = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });
let selected = null;
let sending = false;
let busy = false;
let refreshing;
let deleting = false;
let renderedHistory = '';
let renderedDetail = '';
let previousImportId = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function syncControls() {
  const disabled = sending || busy;
  video.disabled = disabled;
  if (importForm) driveUrl.disabled = driveSubmit.disabled = disabled;
}

function showNotice(text, error = false) {
  previousImportId = null;
  if (previousButton) previousButton.hidden = true;
  notice.textContent = text;
  notice.classList.toggle('problem', error);
}

function meetingMeta(record) {
  const source = record.source === 'google-drive' ? 'Google Drive'
    : record.source === 'upload' ? 'Загружено вручную' : '';
  return [date.format(new Date(record.addedAt)), source, labels[record.status], phases[record.phase]]
    .filter(Boolean).join(' · ');
}

function showDetail(record) {
  const signature = JSON.stringify(record);
  if (signature === renderedDetail) return;
  renderedDetail = signature;
  const title = el('h2', record.name);
  title.id = 'detail-title';
  detail.replaceChildren(title, el('p', meetingMeta(record), 'meta'));
  if (record.error) detail.append(el('p', record.error, 'problem'));
  if (record.notesWarning) detail.append(el('p', record.notesWarning, 'problem'));
  if (record.cleanupWarning) detail.append(el('p', record.cleanupWarning, 'problem'));
  if (record.notes) {
    for (const [key, label] of Object.entries(sections)) {
      detail.append(el('h3', label));
      if (!record.notes[key].length) {
        detail.append(el('p', 'Не зафиксировано.'));
        continue;
      }
      const list = el('ul', '');
      for (const entry of record.notes[key]) {
        const item = el('li', entry.text);
        const source = el('details', '');
        source.append(el('summary', 'Цитата из транскрипта'), el('p', entry.evidence));
        item.append(source);
        list.append(item);
      }
      detail.append(list);
    }
  }
  if (record.transcript) detail.append(el('h3', 'Полный транскрипт'), el('p', record.transcript, 'transcript'));
}

async function select(id) {
  selected = id;
  for (const button of history.querySelectorAll('button[data-id]')) button.setAttribute('aria-current', String(button.dataset.id === id));
  try {
    const record = await api('/api/meetings/' + id);
    if (selected === id) showDetail(record);
  } catch (error) {
    if (selected === id) showNotice(error.message, true);
  }
}

function clearDetail() {
  selected = null;
  renderedDetail = '';
  const title = el('h2', 'Результат');
  title.id = 'detail-title';
  detail.replaceChildren(title, el('p', 'Выберите встречу из истории.'));
}

async function removeMeeting(record, button) {
  if (deleting || record.status === 'processing' || !window.confirm('Удалить эту встречу из истории?')) return;
  deleting = true;
  button.disabled = true;
  try {
    await refreshing;
    await api('/api/meetings/' + record.id, { method: 'DELETE' });
    if (selected === record.id) clearDetail();
    const removed = [...history.querySelectorAll('button[data-id]')].find(item => item.dataset.id === record.id);
    removed?.parentElement.remove();
    empty.hidden = history.childElementCount !== 0;
    renderedHistory = '';
    showNotice('Встреча удалена из истории.');
  } catch (error) {
    showNotice('Не удалось удалить встречу. ' + error.message, true);
    return;
  } finally {
    deleting = false;
    button.disabled = false;
  }
  await refresh();
}

function refresh() {
  if (deleting) return;
  return refreshing ??= loadHistory().finally(() => { refreshing = undefined; });
}

async function loadHistory() {
  try {
    const records = await api('/api/meetings');
    busy = records.some(record => record.status === 'processing');
    syncControls();
    if (selected && !sending && !records.some(record => record.id === selected)) clearDetail();
    const signature = JSON.stringify(records);
    if (signature !== renderedHistory) {
      const focusedId = document.activeElement?.dataset.id;
      const focusedDeleteId = document.activeElement?.dataset.deleteId;
      renderedHistory = signature;
      history.replaceChildren(...records.map(record => {
        const row = el('li', '');
        const button = el('button', record.name);
        button.type = 'button';
        button.dataset.id = record.id;
        button.setAttribute('aria-current', String(selected === record.id));
        button.append(el('small', meetingMeta(record)));
        button.addEventListener('click', () => void select(record.id));
        const remove = el('button', '🗑', 'delete-meeting');
        remove.type = 'button';
        remove.dataset.deleteId = record.id;
        remove.disabled = record.status === 'processing';
        remove.title = remove.disabled ? 'Встреча ещё обрабатывается' : 'Удалить встречу';
        remove.setAttribute('aria-label', 'Удалить встречу «' + record.name + '»');
        remove.addEventListener('click', () => removeMeeting(record, remove));
        row.append(button, remove);
        return row;
      }));
      if (focusedId) [...history.querySelectorAll('button[data-id]')].find(b => b.dataset.id === focusedId)?.focus();
      if (focusedDeleteId) [...history.querySelectorAll('.delete-meeting')].find(b => b.dataset.deleteId === focusedDeleteId)?.focus();
      empty.hidden = records.length !== 0;
    }
    if (selected || records.length) await select(selected ?? records[0].id);
  } catch (error) {
    if (!sending) showNotice(error.message, true);
  }
}

video.addEventListener('change', async () => {
  const file = video.files[0];
  if (!file || sending || busy) return;
  if (!/\.(mp4|webm)$/i.test(file.name) || !file.size || file.size > 50_000_000) {
    showNotice('Выберите непустой файл MP4 или WebM размером до 50 МБ.', true);
    video.value = '';
    return;
  }
  sending = true;
  syncControls();
  showNotice('Загрузка записи…');
  try {
    const { id } = await api('/api/meetings', {
      method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: file,
    });
    busy = true;
    showNotice('');
    await select(id);
  } catch (error) {
    showNotice(error.message || 'Загрузка не удалась.', true);
  } finally {
    sending = false;
    video.value = '';
    syncControls();
    await refresh();
  }
});

if (importForm) {
  previousButton.addEventListener('click', () => {
    if (previousImportId) return select(previousImportId);
  });

  importForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || busy) return;
    const url = driveUrl.value.trim();
    if (!url) {
      showNotice('Введите публичную ссылку Google Drive.', true);
      return;
    }
    sending = true;
    syncControls();
    showNotice('Скачивание и проверка видео…');
    try {
      const response = await fetch('/api/imports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      const data = await response.json().catch(() => null);
      const id = data?.id;
      if ((response.status === 202 || response.status === 200) && typeof id === 'string' && id) {
        if (response.status === 202) busy = true;
        showNotice(response.status === 202 ? 'Файл принят. Анализ начался.' : 'Эта встреча уже есть в истории.');
        driveUrl.value = '';
        await refreshing;
        await select(id);
      } else if (response.status === 409 && typeof id === 'string' && id) {
        showNotice('Файл уже зарегистрирован, но предыдущая обработка не завершилась успешно.', true);
        previousImportId = id;
        previousButton.hidden = false;
      } else {
        const message = data?.error || 'Не удалось импортировать видео. Проверьте ссылку и попробуйте снова.';
        const manualHint = response.status === 400 || response.status === 422
          ? ' Если файл можно скачать из Google Drive, сохраните его и выберите через ручную загрузку выше.'
          : '';
        showNotice(message + manualHint, true);
      }
    } catch {
      showNotice('Не удалось связаться с сервером для импорта видео.', true);
    } finally {
      sending = false;
      syncControls();
      await refresh();
    }
  });
}

void refresh();
setInterval(() => void refresh(), 1800);

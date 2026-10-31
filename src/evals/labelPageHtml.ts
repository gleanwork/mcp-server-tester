/**
 * The `mst label` page: one self-contained HTML file. Its script loads the
 * items from `api/items` and posts each answer to `api/label`. It writes
 * every value with `textContent`, never as HTML.
 */

const STYLE = `
  :root { color-scheme: light dark; --line: #8884; --muted: #888; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 1100px; margin-inline: auto; }
  header { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: var(--muted); }
  details.question { margin: 12px 0; }
  details.question div { white-space: pre-wrap; padding: 8px 12px; border-left: 3px solid var(--line); }
  section { margin: 16px 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 4px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; }
  .event { border: 1px solid var(--line); border-radius: 6px; margin: 4px 0; }
  .event summary { cursor: pointer; padding: 4px 12px; }
  .event pre { margin: 0; padding: 4px 12px 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
  .error { color: #dc2626; }
  .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .actions { position: sticky; bottom: 0; background: Canvas; border-top: 1px solid var(--line); padding: 12px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: ButtonFace; color: ButtonText; cursor: pointer; }
  button.chosen { outline: 2px solid var(--accent); }
  button kbd { color: var(--muted); font-size: 12px; margin-left: 6px; }
  textarea { font: inherit; width: 100%; min-height: 2.5em; margin-top: 8px; }
  #choices { display: inline-flex; gap: 8px; }
  #status { margin-left: auto; }
`;

const SCRIPT = `
const state = { data: null, index: 0, saving: false };
const $ = (id) => document.getElementById(id);
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v; else node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}
function textBlock(title, value) {
  if (value === undefined || value === '') return null;
  return el('section', null, el('h2', { text: title }), el('div', { class: 'text', text: value }));
}
function events(trial) {
  if (!trial.traced) return el('p', { class: 'muted', text: 'The client recorded no calls.' });
  if (trial.events.length === 0) return el('p', { class: 'muted', text: 'No calls.' });
  const list = el('div');
  for (const event of trial.events) {
    const title = [event.kind, event.name, event.server ? '(' + event.server + ')' : ''].filter(Boolean).join(' ');
    const box = el('details', { class: 'event' }, el('summary', { text: title, class: event.isError ? 'error' : '' }));
    for (const [name, value] of [['input', event.input], ['output', event.output], ['text', event.text]])
      if (value) box.append(el('pre', { text: name + ': ' + value }));
    list.append(box);
  }
  return list;
}
function trialView(trial, title) {
  return el('div', null,
    el('section', null, el('h2', { text: (title ? title + ': ' : '') + 'calls' }), events(trial)),
    textBlock((title ? title + ': ' : '') + 'answer', trial.answer ?? '(no answer)'));
}
function choices(item) {
  if (state.data.kind === 'pointwise')
    return [['pass', 'Pass', 'p'], ['fail', 'Fail', 'f']];
  return [[item.sides[0].label, 'A is better', 'a'], ['tie', 'Tie', 't'], [item.sides[1].label, 'B is better', 'b']];
}
// A label as its button names it: a pairwise label says A or B, never
// which side is the baseline.
function labelText(item, label) {
  const choice = choices(item).find(([value]) => value === label);
  return choice ? choice[1] : label;
}
function progress() {
  const items = state.data.items;
  const done = items.filter((item) => item.label !== undefined);
  const tests = done.filter((item) => item.split === 'test').length;
  $('progress').textContent = done.length + ' of ' + items.length + ' labeled (' + tests + ' test, ' + (done.length - tests) + ' dev)';
}
function render() {
  const item = state.data.items[state.index];
  const main = $('item');
  main.replaceChildren();
  progress();
  if (!item) return;
  main.append(el('p', { class: 'muted', text:
    (state.index + 1) + ' of ' + state.data.items.length + ' · case ' + item.caseId +
    (item.trial !== undefined ? ' · trial ' + (item.trial + 1) : '') + ' · ' + item.split + ' split' +
    (item.label !== undefined ? ' · labeled ' + labelText(item, item.label) : '') }));
  main.append(textBlock('Input', item.input));
  main.append(textBlock('Reference answer', item.reference));
  if (item.trace) main.append(trialView(item.trace));
  if (item.sides) {
    const grid = el('div', { class: 'sides' });
    item.sides.forEach((side, i) => {
      const column = el('div', null, el('h2', { text: i === 0 ? 'A' : 'B' }));
      if (side.trialCount > 1)
        column.append(el('p', { class: 'muted', text: 'Trial ' + (side.trialIndex + 1) + ' of ' + side.trialCount + ': the one the judge compared' }));
      column.append(trialView(side.trial));
      grid.append(column);
    });
    main.append(grid);
  }
  const buttons = $('choices');
  buttons.replaceChildren();
  for (const [value, text, key] of choices(item)) {
    const button = el('button', { type: 'button', class: item.label === value ? 'chosen' : '' }, text, el('kbd', { text: key.toUpperCase() }));
    button.addEventListener('click', () => save(value));
    buttons.append(button);
  }
  $('note').value = item.note ?? '';
}
async function save(label) {
  // One save at a time, so a second key press can't label an item unseen.
  if (state.saving) return;
  state.saving = true;
  const index = state.index;
  const item = state.data.items[index];
  const note = $('note').value.trim();
  $('status').textContent = 'Saving…';
  $('status').className = '';
  try {
    const response = await fetch('api/label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, label, ...(note ? { note } : {}) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    item.label = body.label;
    item.split = body.split;
    if (note) item.note = note; else delete item.note;
    $('status').textContent = 'Saved ' + labelText(item, body.label) + '.';
    // Move on only from the item just labeled, not one the person went to.
    if (state.index === index) next(true); else render();
  } catch (error) {
    $('status').textContent = String(error.message ?? error);
    $('status').className = 'error';
  } finally {
    state.saving = false;
  }
}
function next(unlabeled) {
  const items = state.data.items;
  if (unlabeled) {
    for (let step = 1; step <= items.length; step++) {
      const i = (state.index + step) % items.length;
      if (items[i].label === undefined) { state.index = i; render(); return; }
    }
    $('status').textContent = 'Every item has a label. Close this page and press Ctrl+C in the terminal.';
    render();
    return;
  }
  state.index = Math.min(items.length - 1, state.index + 1);
  render();
}
function previous() {
  state.index = Math.max(0, state.index - 1);
  render();
}
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.target instanceof HTMLTextAreaElement || event.metaKey || event.ctrlKey || event.altKey) return;
  const item = state.data?.items[state.index];
  if (!item) return;
  const choice = choices(item).find(([, , key]) => key === event.key.toLowerCase());
  if (choice) { save(choice[0]); event.preventDefault(); }
  else if (event.key === 'ArrowRight' || event.key === 'j') next(false);
  else if (event.key === 'ArrowLeft' || event.key === 'k') previous();
  else if (event.key === 'n') next(true);
});
$('previous').addEventListener('click', previous);
$('next').addEventListener('click', () => next(false));
$('skip').addEventListener('click', () => next(true));
fetch('api/items').then((response) => response.json()).then((data) => {
  state.data = data;
  $('title').textContent = 'Label ' + data.judge;
  $('run').textContent = 'run ' + data.runId;
  if (data.question) { $('question-text').textContent = data.question; $('question').hidden = false; }
  else $('no-question').hidden = false;
  const first = data.items.findIndex((item) => item.label === undefined);
  state.index = first === -1 ? 0 : first;
  render();
}).catch((error) => { $('status').textContent = String(error); $('status').className = 'error'; });
`;

/** The page `mst label` serves. */
export function labelPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mst label</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1 id="title">Label</h1>
  <span id="run" class="muted"></span>
  <span id="progress" class="muted"></span>
</header>
<details id="question" class="question" hidden><summary>The judge's question</summary><div id="question-text"></div></details>
<p id="no-question" class="error" hidden>MST doesn't know this judge's question. Ask what it checks, and give it with --question, so that your labels answer the question the judge answers.</p>
<p class="muted">Answer the judge's question for each trial. The page doesn't show the judge's verdict or name the variant; the calls a trial made may still show which variant ran it.</p>
<main id="item"></main>
<div class="actions">
  <span id="choices"></span>
  <button type="button" id="previous">Back<kbd>←</kbd></button>
  <button type="button" id="next">Next<kbd>→</kbd></button>
  <button type="button" id="skip">Next unlabeled<kbd>N</kbd></button>
  <span id="status" class="muted"></span>
  <textarea id="note" placeholder="Note (optional): why, for anything unclear"></textarea>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/* Present the existing RSA block kinds; source text is always inserted as text. */
function renderLogContent(target, input) {
  const block = input.block;
  const kind = block?.kind ?? 'text';
  const id = block?.id ?? input.id;
  const same = target.dataset.blockId === id;
  const oldBody = target.querySelector('.log-body');
  const scrollTop = same ? oldBody?.scrollTop ?? 0 : 0;
  const resultOpen = same ? target.querySelector('details')?.open : undefined;
  const focused = same && target.querySelector('summary') === document.activeElement;
  const bodyFocused = same && oldBody === document.activeElement;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function format(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  const paths = {
    thinking: 'M5 16a4 4 0 0 1-1-7.8A5 5 0 0 1 13 5a4 4 0 0 1 6 3 4 4 0 0 1-1 8H5M6 20h.01M3 22h.01',
    text: 'M4 4h16v12H9l-5 4V4m4 4h8m-8 4h5',
    tool: 'm5 6 5 6-5 6m8 0h6',
    system: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m-4 9 3 3 5-6',
    diagnostic: 'M5 20v-7m7 7V4m7 16V9',
  };
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('class', 'log-icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', paths[kind]);
  icon.append(path);
  const title = block?.title ?? input.title;
  const header = el('div', 'log-header');
  const heading = el('span', 'log-title', title);
  heading.title = title;
  header.append(icon, heading);
  const status = block?.status ?? input.status;
  if (kind === 'tool' || status === 'error') {
    header.append(el('span', 'log-status', status === 'running' ? '运行中' : status === 'error' ? '出错' : '完成'));
  } else if (status === 'running') {
    const dots = el('span', 'log-stream', '•••');
    dots.setAttribute('aria-label', '正在生成');
    header.append(dots);
  }
  const content = el('div', 'log-body');
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', `${title}内容，可滚动`);
  if (kind === 'tool' && block.tool) {
    const tool = block.tool;
    if (tool.intent) content.append(el('p', 'log-intent', tool.intent));
    if (tool.args !== undefined) {
      const args = el('pre', 'log-code', typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args));
      args.setAttribute('aria-label', '参数');
      content.append(args);
    }
    if (tool.result !== undefined) {
      const details = el('details', 'log-result');
      details.open = resultOpen ?? status === 'error';
      const summary = el('summary', '', '结果');
      summary.addEventListener('click', event => {
        event.preventDefault();
        details.open = !details.open;
        if (details.open) content.scrollTop += details.getBoundingClientRect().top - content.getBoundingClientRect().top;
      });
      details.append(summary, el('pre', 'log-code', format(tool.result)));
      content.append(details);
    }
  } else if ((kind === 'system' || kind === 'diagnostic') && block.data && Object.keys(block.data).length) {
    if (kind === 'system' && block.title === 'control') {
      const label = { auto: 'AI 已接管', manual: '已交还控制权' }[block.data.mode];
      if (label) content.append(el('p', 'log-event', label));
    }
    const fields = el('dl', 'log-fields');
    for (const [key, value] of Object.entries(block.data)) {
      fields.append(el('dt', '', key), el('dd', '', format(value)));
    }
    content.append(fields);
  } else {
    content.append(el('p', 'log-prose', block?.text ?? input.description ?? ''));
  }
  target.dataset.kind = kind;
  target.dataset.status = status;
  target.dataset.blockId = id;
  target.replaceChildren(header, content);
  content.scrollTop = scrollTop;
  if (focused) target.querySelector('summary')?.focus({ preventScroll: true });
  else if (bodyFocused) content.focus({ preventScroll: true });
}

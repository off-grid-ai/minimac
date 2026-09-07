const DEFAULT_TAIL_GAP = 40;

// Capture the row the reader can currently see. A numeric scrollTop is not a
// stable reading position when a streamed row above it changes height.
export function captureScrollAnchor(scroller, tailGap = DEFAULT_TAIL_GAP) {
  const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (remaining <= tailGap) return { mode: 'tail' };

  const viewportTop = scroller.getBoundingClientRect().top;
  const anchor = [...scroller.children].find((row) =>
    row.dataset.scrollKey && row.getBoundingClientRect().bottom > viewportTop);

  return {
    mode: 'anchor',
    key: anchor?.dataset.scrollKey ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0,
    scrollTop: scroller.scrollTop,
  };
}

export function restoreScrollAnchor(scroller, position) {
  if (!position || position.mode === 'tail') {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }

  const anchor = [...scroller.children]
    .find((row) => row.dataset.scrollKey === position.key);
  if (!anchor) {
    scroller.scrollTop = position.scrollTop;
    return;
  }

  const currentOffset = anchor.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top;
  scroller.scrollTop += currentOffset - position.offset;
}

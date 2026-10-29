/** Leave modified clicks and non-primary buttons to the browser. */
export function isPlainNavigationClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}) {
  return event.button === 0 && !event.defaultPrevented &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Truncate text to maxLen characters, appending '…' if truncated.
 * @param {string} text - input text
 * @param {number} maxLen - maximum length including ellipsis
 * @returns {string}
 */
export function truncate(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

export function applyStyleToElement(
  element: HTMLElement,
  key: string,
  value: string
) {
  const currentStyle = element.getAttribute('style') || '';
  // Remove the existing variable definitions with the same name
  const cleanedStyle = currentStyle
    .replace(
      // eslint-disable-next-line security/detect-non-literal-regexp
      new RegExp(`--${key}:\\s*[^;]+;?`, 'g'),
      ''
    )
    .trim();

  element.setAttribute('style', `${cleanedStyle}--${key}: ${value};`);
}

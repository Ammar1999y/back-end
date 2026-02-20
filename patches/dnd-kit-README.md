التغيرات الي بيتم على الكود الاساسي

```tsx
export function getScrollPosition(scrollingContainer: Element) {
  const minScroll = {
    x: 0,
    y: 0,
  };
  const dimensions = isDocumentScrollingElement(scrollingContainer)
    ? {
        height: window.innerHeight,
        width: window.innerWidth,
      }
    : {
        height: scrollingContainer.clientHeight,
        width: scrollingContainer.clientWidth,
      };
  const maxScroll = {
    x: scrollingContainer.scrollWidth - dimensions.width,
    y: scrollingContainer.scrollHeight - dimensions.height,
  };

  // Detect RTL direction
  const isRTL = getComputedStyle(scrollingContainer).direction === 'rtl';

  const scrollLeft = scrollingContainer.scrollLeft;

  const isTop = scrollingContainer.scrollTop <= minScroll.y;
  const isBottom = scrollingContainer.scrollTop >= maxScroll.y;

  let isLeft: boolean;
  let isRight: boolean;

  if (isRTL) {
    // In RTL, scrollLeft behavior varies by browser:
    // - Chrome/Edge: 0 at start (right), negative when scrolled left
    // - Firefox: 0 at end (left), negative when scrolled right (towards start)
    // - Safari: 0 at end (left), positive when scrolled right (towards start)
    //
    // isRight = can't scroll more to the right (at rightmost position)
    // isLeft = can't scroll more to the left (at leftmost position)

    if (scrollLeft > 0) {
      // Safari: positive scrollLeft, 0 at left edge, maxScroll at right edge
      isLeft = scrollLeft <= 0;
      isRight = scrollLeft >= maxScroll.x;
    } else {
      // Chrome/Firefox: 0 or negative scrollLeft
      // At rightmost (start in RTL): scrollLeft = 0
      // At leftmost (end in RTL): scrollLeft = -maxScroll.x (Chrome) or 0 (Firefox at end)
      const absScrollLeft = Math.abs(scrollLeft);
      isRight = scrollLeft >= 0; // At start (rightmost)
      isLeft = absScrollLeft >= maxScroll.x; // At end (leftmost)
    }
  } else {
    // LTR behavior (original)
    isLeft = scrollLeft <= minScroll.x;
    isRight = scrollLeft >= maxScroll.x;
  }

  return {
    isTop,
    isLeft,
    isBottom,
    isRight,
    maxScroll,
    minScroll,
  };
}
```

التغيرات على ملفات core.cjs.development.js & core.esm.js

```js
function getScrollPosition(scrollingContainer) {
  const minScroll = {
    x: 0,
    y: 0,
  };
  const dimensions = isDocumentScrollingElement(scrollingContainer)
    ? {
        height: window.innerHeight,
        width: window.innerWidth,
      }
    : {
        height: scrollingContainer.clientHeight,
        width: scrollingContainer.clientWidth,
      };
  const maxScroll = {
    x: scrollingContainer.scrollWidth - dimensions.width,
    y: scrollingContainer.scrollHeight - dimensions.height,
  };

  // RTL Support: Detect direction
  const isRTL = getComputedStyle(scrollingContainer).direction === 'rtl';
  const scrollLeft = scrollingContainer.scrollLeft;

  const isTop = scrollingContainer.scrollTop <= minScroll.y;
  const isBottom = scrollingContainer.scrollTop >= maxScroll.y;

  let isLeft;
  let isRight;

  if (isRTL) {
    // In RTL, scrollLeft behavior varies by browser:
    // - Chrome/Edge: 0 at start (right), negative when scrolled left
    // - Firefox: 0 at end (left), negative when scrolled right (towards start)
    // - Safari: 0 at end (left), positive when scrolled right (towards start)
    //
    // isRight = can't scroll more to the right (at rightmost position)
    // isLeft = can't scroll more to the left (at leftmost position)

    if (scrollLeft > 0) {
      // Safari: positive scrollLeft, 0 at left edge, maxScroll at right edge
      isLeft = scrollLeft <= 0;
      isRight = scrollLeft >= maxScroll.x;
    } else {
      // Chrome/Firefox: 0 or negative scrollLeft
      // At rightmost (start in RTL): scrollLeft = 0
      // At leftmost (end in RTL): scrollLeft = -maxScroll.x (Chrome) or 0 (Firefox at end)
      const absScrollLeft = Math.abs(scrollLeft);
      isRight = scrollLeft >= 0; // At start (rightmost)
      isLeft = absScrollLeft >= maxScroll.x; // At end (leftmost)
    }
  } else {
    isLeft = scrollLeft <= minScroll.x;
    isRight = scrollLeft >= maxScroll.x;
  }

  return {
    isTop,
    isLeft,
    isBottom,
    isRight,
    maxScroll,
    minScroll,
  };
}
```

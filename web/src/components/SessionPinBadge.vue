<template>
  <span class="session-pin-badge" aria-label="已置顶" title="已置顶">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.8 1.6 14.4 5.2l-2 1.2-.8 3.2-1 1-2.2-2.2-4.8 4.8-.8-.8 4.8-4.8-2.2-2.2 1-1 3.2-.8 1.2-2Z" />
    </svg>
    <span>置顶</span>
  </span>
</template>

<style scoped>
.session-pin-badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  box-sizing: border-box;
  height: 18px;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--accent, #58a6ff) 28%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent, #58a6ff) 10%, transparent);
  color: var(--accent, #58a6ff);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
}
.session-pin-badge svg {
  width: 11px;
  height: 11px;
  flex: 0 0 auto;
  fill: currentColor;
}
</style>

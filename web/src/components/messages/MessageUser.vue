<template>
  <!-- User message: right-aligned bubble (the only message type that keeps
       the chat-bubble layout — emphasizes "this is what I said"). -->
  <div class="msg msg-user">{{ content }}</div>
</template>

<script setup lang="ts">
defineProps<{ content: string }>()
</script>

<style scoped>
.msg {
  /* Width follows content; max-width caps it so long messages wrap. */
  width: fit-content;
  max-width: 85%;
  align-self: flex-end;
  word-break: break-word;
  animation: fade-in 0.2s ease;
}
.msg-user {
  background: var(--user-bubble);
  color: #fff;
  padding: 10px 16px;
  border-radius: 16px 16px 4px 16px;
  font-size: 14px;
  line-height: 1.6;
}
@media (max-width: 768px) {
  .msg { max-width: 90%; }
}
</style>

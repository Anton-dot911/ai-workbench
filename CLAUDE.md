# CLAUDE.md: AI Воркбенч

Персональна PWA з агентами на Claude API (специфікація: `PWA-multitools.pdf`). Стек: Vite + React + TypeScript, Dexie, MiniSearch (етап 2), проксі на Vercel Functions (Node.js) + Upstash Redis.

## INVARIANTS (порушувати заборонено)

1. Ключ Anthropic існує лише в змінних середовища Vercel. У `src/` його немає і бути не може.
2. Проксі fail-closed: немає `APP_TOKEN`, `ANTHROPIC_API_KEY` чи Redis → запити відхиляються.
3. Проксі приймає лише моделі з `shared/pricing.ts` і `max_tokens` ≤ `MAX_OUTPUT_TOKENS`.
4. Service Worker ніколи не кешує `/api/*` (`navigateFallbackDenylist`, жодного `runtimeCaching` для API).
5. Конкретні назви моделей лише в `src/core/settings.ts` та `shared/pricing.ts`; агенти використовують `fast | balanced | deep`.
6. Користувацькі й зовнішні дані завжди в XML-тегах (`xml()` у `contextBuilder.ts`), ніколи не конкатенуються в інструкції.
7. Пам'ять змінюється тільки через пропозицію + підтвердження користувача (з етапу 3). Агенти самі в пам'ять не пишуть.
8. Дії зі змінами даних (перезапис, видалення, відправка) потребують підтвердження користувача.
9. CSP у `vercel.json`: `connect-src 'self'`. Не послаблювати без причини в `LESSONS.md`.

## Команди

- `npm run check`: typecheck + тести + збірка (це і є DoD, показувати сирий вивід)
- `npm run dev`: `vercel dev` (потрібен `vercel env pull .env.local`)
- `npm run dev:ui`: лише Vite, `/api` проксюється на `API_ORIGIN` (за замовчуванням `localhost:3000`)

## Дизайн

Холодний папір + темно-синій `#1F3864` + сигнальний жовтий `#F2C230`. Лінійка-індикатор (`.gauge`) для довжини, токенів і витрат; світла й темна теми через змінні в `src/styles.css`. Тексти відповідей шрифтом із засічками, інтерфейс системним.

## Current State

Етап 1 реалізовано й перевірено в пісочниці (typecheck, 18 тестів, збірка). Не перевірено: деплой на Vercel, реальний виклик Anthropic, встановлення на iOS (див. T1.6 у `PLAN.md`). Далі: етап 2 (контекст).

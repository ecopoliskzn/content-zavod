// Типы для lib/ig/match.mjs — правило подбора сценария живёт в .mjs, потому что
// его читают и движок (обычный node), и сайт. Второй копии правила быть не должно,
// поэтому не переписываем модуль на TypeScript, а описываем его здесь.

export type Сценарий = {
  ключ: string;
  слова?: string[];
  где?: string[];
  включён?: boolean;
  приоритет?: number;
  совпадение?: string;
  шаблон?: string;
  сборка?: string;
  максДлина?: number;
  медиа?: string[];
  [ключ: string]: unknown;
};

export type Находка = { сценарий: Сценарий; слово: string; вид: string };

export function норма(текст: string): string;
export function отдельноеСлово(текст: string, слово: string): boolean;
export function подобрать(текст: string, сценарии: Сценарий[], где?: string): Находка | null;
export function персональнаяМетка(метка: string, igsid: string): string;
export function подставить(текст: string, значения: Record<string, string>): string;

import { Chat } from "./Chat";

export default function GUI() {
  return (
    <div className="flex h-full min-h-0 w-screen flex-row overflow-hidden">
      {/* min-w-0 обязателен: у flex-1 по умолчанию min-width:auto, поэтому
          колонка не могла сжаться ниже min-content своего содержимого. Одна
          длинная неразрывная строка (команда воркера, путь) раздувала ленту
          шире панели — замер: вьюпорт 796px, колонка 1351px, — а внешняя
          обёртка с overflow-x-hidden просто обрезала лишнее. */}
      <main className="no-scrollbar relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Chat />
      </main>
    </div>
  );
}

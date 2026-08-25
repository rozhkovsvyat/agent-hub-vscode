import { History } from "../../components/History";
import { Chat } from "./Chat";

export default function GUI() {
  return (
    <div className="flex min-h-0 w-screen flex-row overflow-x-hidden">
      <aside className="4xl:flex border-vsc-input-border no-scrollbar hidden min-h-0 w-96 overflow-y-auto border-0 border-r border-solid">
        <History />
      </aside>
      {/* min-w-0 обязателен: у flex-1 по умолчанию min-width:auto, поэтому
          колонка не могла сжаться ниже min-content своего содержимого. Одна
          длинная неразрывная строка (команда воркера, путь) раздувала ленту
          шире панели — замер: вьюпорт 796px, колонка 1351px, — а внешняя
          обёртка с overflow-x-hidden просто обрезала лишнее. */}
      <main className="no-scrollbar flex min-h-0 min-w-0 flex-1 flex-col">
        <Chat />
      </main>
    </div>
  );
}

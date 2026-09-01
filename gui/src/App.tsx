import { Navigate, RouterProvider, createMemoryRouter } from "react-router-dom";
import Layout from "./components/Layout";
import { MainEditorProvider } from "./components/mainInput/TipTapEditor";
import { SubmenuContextProvidersProvider } from "./context/SubmenuContextProviders";
import { VscThemeProvider } from "./context/VscTheme";
import ParallelListeners from "./hooks/ParallelListeners";
import { ClaudePermissionPrompt } from "./components/mainInput/ClaudePermissionPrompt";
import ConfigPage from "./pages/config";
import ErrorPage from "./pages/error";
import Chat from "./pages/gui";
import Stats from "./pages/stats";
import ThemePage from "./styles/ThemePage";
import { ROUTES } from "./util/navigation";
import CukiiSessionNavigator from "./pages/sessions/CukiiSessionNavigator";

document.documentElement.dataset.cukiiSurface = window.cukiiSurface ?? "chat";
// Panel ids carry a random suffix now; derive the alternating tone from a
// stable hash of the whole id instead of a trailing counter.
const panelToneSeed = [...(window.cukiiPanelId ?? "sidebar")].reduce(
  (sum, ch) => sum + ch.charCodeAt(0),
  0,
);
document.documentElement.dataset.cukiiPanelTone =
  panelToneSeed % 2 === 0 ? "light" : "dark";

const router = createMemoryRouter([
  {
    path: ROUTES.HOME,
    element: <Layout />,
    errorElement: <ErrorPage />,
    children: [
      {
        path: "/index.html",
        element: <Chat />,
      },
      {
        path: ROUTES.HOME,
        element: <Chat />,
      },
      {
        path: "/history",
        element: <Navigate replace to={ROUTES.HOME} />,
      },
      {
        path: ROUTES.STATS,
        element: <Stats />,
      },
      {
        path: ROUTES.CONFIG,
        element: <ConfigPage />,
      },
      {
        path: ROUTES.THEME,
        element: <ThemePage />,
      },
    ],
  },
]);

/*
  ParallelListeners prevents entire app from rerendering on any change in the listeners,
  most of which interact with redux etc.
*/
function App() {
  if (window.cukiiSurface === "sidebar") {
    return (
      <VscThemeProvider>
        <CukiiSessionNavigator />
      </VscThemeProvider>
    );
  }

  return (
    <VscThemeProvider>
      <MainEditorProvider>
        <SubmenuContextProvidersProvider>
          <RouterProvider router={router} />
        </SubmenuContextProvidersProvider>
      </MainEditorProvider>
      <ParallelListeners />
      <ClaudePermissionPrompt />
    </VscThemeProvider>
  );
}

export default App;

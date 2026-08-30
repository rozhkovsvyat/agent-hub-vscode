/** Match only the retired full-screen history route and its URL variants. */
export function isLegacyHistoryRoute(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let route = value.trim().toLowerCase().split(/[?#]/, 1)[0];
  route = route.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/, "");
  route = route.replace(/\/+$/, "");
  return route === "/history" || route === "history";
}

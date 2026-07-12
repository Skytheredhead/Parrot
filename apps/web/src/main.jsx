import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { readProductionConfig } from "./production-runtime.js";
import "./styles.css";

const config = readProductionConfig();

function AuthenticatedApp() {
  const auth = useAuth();
  React.useEffect(() => {
    if (!auth.isLoading && !auth.user && window.location.pathname === "/login") {
      void auth.signIn({ state: { returnTo: "/" } });
    }
  }, [auth]);
  return <App auth={auth} />;
}

function Root() {
  if (!config.live || !config.configured) return <App />;
  return (
    <AuthKitProvider
      clientId={config.clientId}
      apiHostname={config.apiHostname || undefined}
      devMode={config.devMode}
      redirectUri={config.redirectUri}
      onRedirectCallback={({ state }) => {
        const returnTo = state?.returnTo;
        window.history.replaceState(
          {},
          "",
          typeof returnTo === "string" && returnTo.startsWith("/") ? returnTo : "/",
        );
      }}
    >
      <AuthenticatedApp />
    </AuthKitProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

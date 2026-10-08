//! App wiring: providers + store + WS + Shell. Stub — product-v3 freeze.

import { Shell } from "./components/Shell.js";
import { LocaleProvider } from "./i18n/index.js";
import { initialAuthState } from "./state/auth.js";

const noop = () => undefined;

export function App() {
  return (
    <LocaleProvider>
      <Shell
        auth={initialAuthState}
        market={null}
        book={null}
        candles={[]}
        trades={[]}
        portfolio={null}
        interval="1m"
        status={null}
        actions={{
          connect: noop,
          disconnect: noop,
          login: noop,
          bind: noop,
          faucet: noop,
          deposit: noop,
          withdraw: noop,
          submitOrder: noop,
          closePosition: noop,
          setInterval: noop,
        }}
      />
    </LocaleProvider>
  );
}

// "Connect another company" — re-enters the setup wizard at its Connect step
// (env pick → Intuit OAuth). The wizard treats ?step=4 as a fresh connection.

import { Navigate } from 'react-router-dom';

export default function Connect() {
  return <Navigate to="/setup?step=4" replace />;
}

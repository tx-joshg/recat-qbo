// "Connect another company" — re-enters the setup wizard at its Connect step.
// The wizard resolves the connection mode from the instance state: REAL when
// Intuit credentials are configured, demo otherwise (the Back button still
// reaches the rest of the wizard if the user wants to change course).

import { Navigate } from 'react-router-dom';

export default function Connect() {
  return <Navigate to="/setup?step=connect" replace />;
}

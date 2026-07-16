// "Connect another company" — re-enters the setup wizard at its Connect step.
// With no ?mode the wizard shows the demo-vs-real chooser; ?mode=real (e.g.
// from the Settings upgrade card) skips the chooser straight to the real path.

import { Navigate, useSearchParams } from 'react-router-dom';

export default function Connect() {
  const [params] = useSearchParams();
  const real = params.get('mode') === 'real';
  return <Navigate to={real ? '/setup?step=connect&mode=real' : '/setup?step=connect'} replace />;
}

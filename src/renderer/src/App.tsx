import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';

export default function App(): React.JSX.Element {
  return <RouterProvider router={router} />;
}

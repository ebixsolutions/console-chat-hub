import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  // Start's client splitter removes route-level `ssr` literals. A fresh
  // client match can otherwise lose the server's existing client-only boundary
  // before hydration (reproduced on /login). Preserve only the two routes that
  // already explicitly set ssr:false; Auth beforeLoad remains unchanged.
  router.routesById["/login"].options.ssr = false;
  router.routesById["/_authenticated"].options.ssr = false;

  return router;
};

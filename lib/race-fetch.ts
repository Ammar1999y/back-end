export async function fastestFetchWithin(
  urls: readonly string[],
  timeoutMs = 3000,
  fetchOptions: RequestInit = {}
): Promise<Response | null> {
  if (!urls.length) return null;

  const ctrls = urls.map(() => new AbortController());

  const requests: Promise<{ i: number; res: Response }>[] = urls.map(
    (url, i) => {
      const p = fetch(url, { ...fetchOptions, signal: ctrls[i].signal }).then(
        (res) => {
          if (!res.ok) throw new Error();
          return { i, res };
        }
      );
      p.catch(() => {});
      return p;
    }
  );

  let tid: NodeJS.Timeout | undefined;

  const timeout = new Promise<null>((resolve) => {
    tid = setTimeout(() => {
      ctrls.forEach((c) => c.abort());
      resolve(null);
    }, timeoutMs);
  });

  const firstSuccess = Promise.any(requests)
    .then(({ i, res }) => {
      if (tid !== undefined) clearTimeout(tid);
      ctrls.forEach((c, idx) => {
        if (idx !== i) c.abort();
      });
      return res;
    })
    .catch(() => {
      if (tid !== undefined) clearTimeout(tid);
      ctrls.forEach((c) => c.abort());
      return null;
    });

  return Promise.race([firstSuccess, timeout]) as Promise<Response | null>;
}

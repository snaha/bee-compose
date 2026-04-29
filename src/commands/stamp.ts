export interface StampOptions {
  amount: string;
  depth: string;
  node: string;
}

interface StampResponse {
  batchID?: string;
}

const SETTLEMENT_WAIT_MS = 15_000;

export async function stampCmd(opts: StampOptions): Promise<void> {
  const url = `${opts.node.replace(/\/$/, '')}/stamps/${opts.amount}/${opts.depth}`;
  console.log(`POST ${url}`);

  const res = await fetch(url, { method: 'POST' });
  const text = await res.text();
  console.log(text);

  if (!res.ok) {
    // Bee returns 400 with a JSON message body when the amount is below the
    // minimum-validity threshold. We've already printed the body — exit.
    throw new Error(`stamp purchase failed: HTTP ${res.status}`);
  }

  let data: StampResponse;
  try {
    data = JSON.parse(text) as StampResponse;
  } catch {
    throw new Error('stamp purchase succeeded but response was not JSON');
  }

  if (!data.batchID) {
    throw new Error('stamp purchase succeeded but response had no batchID');
  }

  console.log(`Waiting ${SETTLEMENT_WAIT_MS / 1000}s for on-chain settlement...`);
  await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_WAIT_MS));
  console.log(`Stamp ready: ${data.batchID}`);
}

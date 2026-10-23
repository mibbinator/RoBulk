// Scripted clicks that put the preview panel into a particular state, used
// for store screenshots. Each demo drives the real UI, like a user would.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function find(root: ParentNode, selector: string, text?: string | RegExp, timeout = 8000): Promise<HTMLElement> {
  const start = Date.now();
  for (;;) {
    const el = [...root.querySelectorAll<HTMLElement>(selector)].find(
      (e) => text === undefined || (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")),
    );
    if (el) return el;
    if (Date.now() - start > timeout) throw new Error(`Demo: nothing matches ${selector} ${text ?? ""}`);
    await sleep(50);
  }
}

async function click(root: ParentNode, selector: string, text?: string | RegExp) {
  (await find(root, selector, text)).click();
  await sleep(120);
}

async function choose(root: ParentNode, selector: string, value: string) {
  const el = (await find(root, selector)) as HTMLSelectElement | HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  await sleep(120);
}

/** Selects every row in a category via its "Select all" checkbox. */
async function selectCategory(root: ParentNode, label: string) {
  const header = await find(root, ".rb-group-header", new RegExp(label));
  header.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
  await sleep(120);
}

const demos: Record<string, (root: HTMLElement) => Promise<void>> = {
  // The Premium-lapse fix: every off-sale shirt and pants staged back on sale.
  async restock(root) {
    await find(root, ".rb-group-toggle", /Classic Pants/);
    await click(root, ".rb-segmented button", "Off sale");
    await selectCategory(root, "Classic Shirts");
    await selectCategory(root, "Classic Pants");
    await click(root, ".rb-actions button", "Put on sale");
    // A couple of individual price tweaks on visible rows so the "was" notes show.
    for (const index of [1, 4]) {
      const input = root.querySelectorAll<HTMLInputElement>(".rb-row .rb-price-field input")[index];
      input.value = String(Number(input.value) + 10);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(150);
    }
    await sleep(300);
  },

  async priceRule(root) {
    await find(root, ".rb-group-toggle", /Classic Shirts/);
    await selectCategory(root, "Classic Shirts");
    await click(root, ".rb-actions .rb-menu > button", /More/);
    await click(root, ".rb-menu-item", /Price rule/);
    await choose(root, ".rb-dialog select", "increasePercent");
    await choose(root, ".rb-dialog input", "50");
    const selects = root.querySelectorAll<HTMLSelectElement>(".rb-dialog select");
    selects[1].value = "none";
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);
  },

  async template(root) {
    await click(root, ".rb-template", /Donation tiers/);
    await sleep(300);
  },
};

export async function runDemo(name: string, root: HTMLElement) {
  try {
    await demos[name]?.(root);
  } catch (e) {
    console.error(e);
  }
  document.body.dataset.demoDone = "1";
}

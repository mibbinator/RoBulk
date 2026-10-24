# RoBulk privacy policy

_Last updated: October 23, 2026_

RoBulk is a browser extension that adds bulk editing and reporting tools to the Roblox Creator Dashboard.

## What RoBulk accesses

RoBulk runs on create.roblox.com and www.roblox.com. On create.roblox.com it reads, from Roblox and only for the account you're signed in with:

- your user id and name, and the groups you belong to along with your role's permissions
- the avatar items, experiences, game passes, developer products and badges you can manage
- the names and review status of classic clothing you uploaded, to warn about items that aren't published yet
- public stats of your experiences (visits, players, favorites, likes)
- your recurring payout percentage in groups you don't own, for the Account Overview
- sale transactions and Robux balance, if you have permission to see them, and the usernames of the buyers the earnings report lists
- which group you last selected in the Creator Dashboard (read from the page itself), so RoBulk can open on the same one

On www.roblox.com it only checks the public catalog for the accounts and groups you've opened in RoBulk, to warn you if their items went off sale.

It sends changes to Roblox only when you click a save, create or copy button.

## What RoBulk stores

Everything below is kept only in your browser, in the extension's own storage (`chrome.storage.local`, and for sales that don't fit there, the extension's own IndexedDB database). Uninstalling the extension removes all of it.

- **Snapshots and change log:** item names, prices and sale status, and a log of changes you saved, so you can undo changes later. You can delete snapshots and clear the log from the History tab.
- **Sales history:** the sale transactions RoBulk has loaded for the earnings report (date, amount, item, and the buyer's Roblox username and id, as Roblox provides them), so later reports only need to fetch new sales. You can turn this off, and clear the saved sales, in the Options tab.
- **Off-sale alarm:** which of your items were on sale when RoBulk last saw them, and any warnings it has shown.
- **Payouts:** the designers you add (Roblox username and id, share and items) and the payouts you mark as paid.
- **Other:** your account and group list (for up to an hour), when you last opened each Earnings report, and the choices you make in the Options tab.

RoBulk asks for unlimited extension storage so a store with a long sales history can be saved in full. It keeps 100,000 sales per account or group unless you change that in the Options tab.

RoBulk never sends Robux or makes payouts. The Payouts tab only works out amounts for you to pay on Roblox.

## What RoBulk does not do

- It has no servers. Nothing is sent anywhere other than Roblox.
- It does not read, store or transmit your password or Roblox session cookie. Requests go through your existing browser session.
- It does not use analytics, tracking or advertising.
- It does not sell or share any data.

## Contact

Questions or problems: open an issue on the project's GitHub repository.

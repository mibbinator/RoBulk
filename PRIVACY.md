# RoBulk privacy policy

_Last updated: October 23, 2026_

RoBulk is a browser extension that adds bulk editing and reporting tools to the Roblox Creator Dashboard.

## What RoBulk accesses

When you open RoBulk on create.roblox.com it reads, from Roblox and only for the account you're signed in with:

- your user id and name, and the groups you belong to along with your role's permissions
- the avatar items, experiences, game passes, developer products and badges you can manage
- the names and review status of classic clothing you uploaded, to warn about items that aren't published yet
- sale transactions and Robux balance, if you have permission to see them
- which group you last selected in the Creator Dashboard (read from the page itself), so RoBulk can open on the same one

It sends changes to Roblox only when you click a save, create or copy button.

## What RoBulk stores

Everything below is kept only in your browser's extension storage (`chrome.storage.local`). Uninstalling the extension removes all of it.

- **Snapshots and change log:** item names, prices and sale status, and a log of changes you saved, so you can undo changes later. You can delete snapshots and clear the log from the History tab.
- **Sales history:** the sale transactions RoBulk has loaded for the earnings report (date, amount, item, and the buyer's Roblox username and id, as Roblox provides them), so later reports only need to fetch new sales. You can turn this off, and clear the saved sales, in the Options tab.
- **Options:** the choices you make in the Options tab.

RoBulk asks for unlimited extension storage so a store with a long sales history can be saved in full. It still keeps at most 250,000 sales per creator.

## What RoBulk does not do

- It has no servers. Nothing is sent anywhere other than Roblox.
- It does not read, store or transmit your password or Roblox session cookie. Requests go through your existing browser session.
- It does not use analytics, tracking or advertising.
- It does not sell or share any data.

## Contact

Questions or problems: open an issue on the project's GitHub repository.

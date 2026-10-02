import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { AdminShell } from "@/components/shell/admin-shell";
import { router, setNavigation } from "@/test/navigation";
import { renderWithMe, staff } from "@/test/render";
import { on, server } from "@/test/server";

function shell(me = staff()) {
  return renderWithMe(
    <AdminShell>
      <h1>Page content</h1>
    </AdminShell>,
    { me },
  );
}

function sidebar() {
  return screen.getAllByRole("navigation", { name: "Admin" })[0] as HTMLElement;
}

describe("AdminShell", () => {
  it("renders the page inside the main landmark", () => {
    shell();
    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "Page content" }),
    ).toBeInTheDocument();
  });

  it("shows an owner every section, grouped", () => {
    shell();
    const nav = within(sidebar());
    for (const group of ["Sell", "Catalog", "People", "Store"]) {
      expect(nav.getByText(group)).toBeInTheDocument();
    }
    expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(nav.getByRole("link", { name: "Audit log" })).toBeInTheDocument();
  });

  it("hides sections, and empty groups, the role cannot use", () => {
    shell(staff({ role: "support", permissions: ["admin:access", "orders:read"] }));
    const nav = within(sidebar());
    expect(nav.getByRole("link", { name: "Orders" })).toBeInTheDocument();
    expect(nav.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(nav.queryByRole("link", { name: "Discounts" })).not.toBeInTheDocument();
    expect(nav.queryByText("People")).not.toBeInTheDocument();
    expect(nav.queryByText("Store")).not.toBeInTheDocument();
  });

  it("marks the current section and shows who is signed in", () => {
    setNavigation({ pathname: "/orders/abc" });
    shell();
    const nav = within(sidebar());
    expect(nav.getByRole("link", { name: "Orders" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Returns" })).not.toHaveAttribute("aria-current");
    expect(nav.getByText("Olu Owner")).toBeInTheDocument();
    expect(nav.getByText("owner")).toBeInTheDocument();
  });

  it("falls back to the email for a staff member without a name", () => {
    shell(staff({ first_name: null, last_name: null, email: "nameless@velo.test" }));
    expect(within(sidebar()).getByText("nameless@velo.test")).toBeInTheDocument();
  });

  it("builds breadcrumbs from the path", () => {
    setNavigation({ pathname: "/orders/vel-1042" });
    shell();
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "Orders" })).toHaveAttribute("href", "/orders");
    expect(crumbs.getByText("vel 1042")).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["/", "Dashboard"],
    ["/orders", "Orders"],
    ["/somewhere-else", "Admin"],
  ])("shows %s as the single current crumb %s", (pathname, label) => {
    setNavigation({ pathname });
    shell();
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByText(label)).toHaveAttribute("aria-current", "page");
    expect(crumbs.queryByRole("link")).not.toBeInTheDocument();
  });

  it("signs out and goes to the sign-in page", async () => {
    let loggedOut = false;
    server.use(
      on("post", "/api/v1/auth/logout", () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    shell();
    await userEvent.setup().click(within(sidebar()).getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/sign-in");
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(loggedOut).toBe(true);
  });

  it("opens the command palette from the search buttons", async () => {
    shell();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Search or jump to…/ }));
    expect(await screen.findByRole("dialog", { name: "Search or jump to" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Search or jump to" }));
    expect(await screen.findByRole("dialog", { name: "Search or jump to" })).toBeInTheDocument();
  });

  it("toggles the command palette with Ctrl+K and ⌘K, ignoring plain K", async () => {
    shell();
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Search or jump to" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("opens the navigation drawer and closes it on navigation", async () => {
    setNavigation({ pathname: "/" });
    const view = shell();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("link", { name: "Orders" })).toBeInTheDocument();

    setNavigation({ pathname: "/orders" });
    view.rerender(
      <AdminShell>
        <h1>Page content</h1>
      </AdminShell>,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    });
  });

  it("includes the theme toggle", () => {
    shell();
    expect(screen.getByRole("group", { name: "Colour theme" })).toBeInTheDocument();
  });
});

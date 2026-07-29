// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import LoginPage from "./page"

vi.mock("next/image", () => ({
  default: () => <span data-testid="login-brand-logo" />,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const organizations = [
  { name: "Contoso", azureOrgName: "contoso", azureOrgUrl: "https://dev.azure.com/contoso" },
  { name: "Fabrikam", azureOrgName: "fabrikam", azureOrgUrl: "https://dev.azure.com/fabrikam" },
]

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ organizations }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
  })

  afterEach(cleanup)

  it("explains how to configure an organization from the organization field", async () => {
    render(
      <TooltipProvider>
        <LoginPage />
      </TooltipProvider>,
    )

    await screen.findByRole("combobox", { name: "Azure DevOps organization" })

    const helpButton = screen.getByRole("button", { name: "How to add an Azure DevOps organization" })
    fireEvent.focus(helpButton)

    expect(helpButton).toHaveAttribute("aria-describedby")
    expect((await screen.findAllByText(/Organizations are configured by your iTestFlow administrator/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText("BOOTSTRAP_AZURE_ORGS").length).toBeGreaterThan(0)
    expect(screen.getAllByText(".env").length).toBeGreaterThan(0)
    expect(screen.getAllByText("orgUrl|ownerEmail").length).toBeGreaterThan(0)
  })
})

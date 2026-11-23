import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { normalizeImportResult, normalizeImportSummary } from "@/lib/importModel";
import { usePostmanImportStore } from "@/stores/postmanImport";
import { importPostmanFile } from "./actions";
import { ImportPostmanDialog } from "./ImportPostmanDialog";

vi.mock("./actions", () => ({ importPostmanFile: vi.fn() }));

const preview = normalizeImportSummary({
  kind: "collection",
  name: "Shop API",
  requests: 3,
  folders: 1,
  warnings: [
    { where: "Orders / Create", message: "Scripts use pm.sendRequest." },
    { where: "", message: "Uses dynamic variables Pakpos doesn't have: $randomEmail." },
  ],
});

function setup() {
  usePostmanImportStore.getState().openDialog();
  render(<ImportPostmanDialog />);
  return userEvent.setup();
}

describe("ImportPostmanDialog", () => {
  beforeEach(() => vi.mocked(importPostmanFile).mockReset());

  it("previews the chosen file with its warnings, then imports it", async () => {
    vi.mocked(api.pickPostmanFile).mockResolvedValue("/home/me/shop.postman_collection.json");
    vi.mocked(api.previewPostman).mockResolvedValue(preview);
    vi.mocked(importPostmanFile).mockResolvedValue(normalizeImportResult({ ...preview, id: "c1" }));
    const user = setup();

    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));

    expect(await screen.findByText('New collection "Shop API"')).toBeInTheDocument();
    expect(screen.getByText("3 requests in 1 folder")).toBeInTheDocument();
    expect(screen.getByText("shop.postman_collection.json")).toBeInTheDocument();
    expect(api.previewPostman).toHaveBeenCalledWith("/home/me/shop.postman_collection.json", {
      guessSecrets: true,
    });
    const warnings = screen.getByRole("list", { name: "Warnings" });
    expect(warnings).toHaveTextContent("Orders / Create: Scripts use pm.sendRequest.");
    expect(warnings).toHaveTextContent("$randomEmail");
    expect(screen.getByText("2 things to check")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(importPostmanFile).toHaveBeenCalledWith(
      "/home/me/shop.postman_collection.json",
      { guessSecrets: true },
      preview,
    );
    await waitFor(() => expect(usePostmanImportStore.getState().open).toBe(false));
  });

  it("previews again when the secrets option changes", async () => {
    vi.mocked(api.pickPostmanFile).mockResolvedValue("/e.json");
    vi.mocked(api.previewPostman).mockResolvedValue(
      normalizeImportSummary({
        kind: "environment",
        name: "Dev",
        variables: 2,
        warnings: [{ where: "", message: "One" }],
      }),
    );
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByText('New environment "Dev"');
    expect(screen.getByText("1 thing to check")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Keep credentials in the secret store" }));
    await waitFor(() =>
      expect(api.previewPostman).toHaveBeenLastCalledWith("/e.json", { guessSecrets: false }),
    );
    expect(usePostmanImportStore.getState().guessSecrets).toBe(false);
  });

  it("shows replaced globals", async () => {
    vi.mocked(api.pickPostmanFile).mockResolvedValue("/g.json");
    vi.mocked(api.previewPostman).mockResolvedValue(
      normalizeImportSummary({ kind: "globals", variables: 2, replaced: ["host", "port"] }),
    );
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("host, port")).toBeInTheDocument();
    expect(screen.getByText(/Replaces existing globals/)).toBeInTheDocument();
  });

  it("shows why a file can't be read and lets the user choose another", async () => {
    vi.mocked(api.pickPostmanFile).mockResolvedValueOnce("/bad.json").mockResolvedValueOnce("/bad.json");
    vi.mocked(api.previewPostman)
      .mockRejectedValueOnce(new Error("This file isn't valid JSON."))
      .mockResolvedValueOnce(preview);
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This file isn't valid JSON.");
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();

    // The same file again (fixed on disk) is read again.
    await user.click(screen.getByRole("button", { name: "Choose another file" }));
    expect(await screen.findByText('New collection "Shop API"')).toBeInTheDocument();
    expect(api.previewPostman).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the file dialog is cancelled, and reports a failing dialog", async () => {
    vi.mocked(api.pickPostmanFile)
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("dialog failed"));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(api.previewPostman).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose file…" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("dialog failed");
  });

  it("keeps the dialog open with the error when the import fails or the store stays locked", async () => {
    vi.mocked(api.pickPostmanFile).mockResolvedValue("/x.json");
    vi.mocked(api.previewPostman).mockResolvedValue(preview);
    vi.mocked(importPostmanFile)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Couldn't write the collection."));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByText('New collection "Shop API"');

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());
    expect(usePostmanImportStore.getState().open).toBe(true);

    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't write the collection.");
    expect(usePostmanImportStore.getState().open).toBe(true);
  });

  it("shows progress while importing and closes on Cancel", async () => {
    vi.mocked(api.pickPostmanFile).mockResolvedValue("/x.json");
    vi.mocked(api.previewPostman).mockResolvedValue(preview);
    let finish: (v: null) => void = () => {};
    vi.mocked(importPostmanFile).mockReturnValue(new Promise((r) => (finish = r)));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByText('New collection "Shop API"');
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeDisabled();
    finish(null);
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(usePostmanImportStore.getState().open).toBe(false);
  });
});

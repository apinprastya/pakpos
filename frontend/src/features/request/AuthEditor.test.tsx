import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { emptyAuth, type Auth } from "@/lib/model";
import { editorView, fieldText, setEditorText, typeInField } from "@/test/editor";
import { AuthEditor } from "./AuthEditor";

/** The auth as last changed by the editor. */
const latest: { current: Auth } = { current: emptyAuth() };
function Host({ initial, onMove }: { initial: Partial<Auth>; onMove?: () => void }) {
  const [auth, setAuth] = useState<Auth>({ ...emptyAuth(), ...initial });
  return (
    <>
      <AuthEditor
        auth={auth}
        onChange={(u) =>
          setAuth((a) => {
            latest.current = u(a);
            return latest.current;
          })
        }
        allowInherit
        onMoveToSecret={onMove}
      />
      <button type="button" onClick={() => setAuth((a) => ({ ...a, token: "{{fromOutside}}" }))}>
        Set from outside
      </button>
    </>
  );
}

describe("secret auth fields", () => {
  it("masks a literal and shows a single reference as a variable field", () => {
    const { unmount } = render(<Host initial={{ type: "bearer", token: "s3cret" }} onMove={() => {}} />);
    expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Move to secret variable" })).toBeInTheDocument();
    unmount();
    render(<Host initial={{ type: "bearer", token: "{{token}}" }} onMove={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Token" })).toHaveAttribute("data-slot", "var-input");
    expect(fieldText("Token")).toBe("{{token}}");
    expect(screen.queryByRole("button", { name: "Move to secret variable" })).not.toBeInTheDocument();
  });

  it("switches to a variable field when {{ is typed, keeping the text and focus", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ type: "bearer" }} onMove={() => {}} />);
    const masked = screen.getByLabelText("Token");
    await user.type(masked, "{{"); // "{{" is user-event's escape for one "{"
    expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password");
    await user.type(masked, "{{");
    // In progress: no plain-text hint while typing a reference.
    expect(screen.queryByRole("button", { name: "Move to secret variable" })).not.toBeInTheDocument();
    await waitFor(() => expect(editorView("Token").hasFocus).toBe(true));
    const view = editorView("Token");
    expect(view.state.doc.toString()).toBe("{{");
    expect(view.state.selection.main.head).toBe(2);
    typeInField("Token", "token}}");
    expect(latest.current.token).toBe("{{token}}");
    expect(view.contentDOM.querySelector(".var-token")).toHaveTextContent("{{token}}");
  });

  it("switches back to masked when the value becomes a literal, caret at the end", async () => {
    render(<Host initial={{ type: "basic", password: "{{pw}}" }} onMove={() => {}} />);
    typeInField("Password", "");
    setEditorText("Password", "plain");
    const input = await screen.findByLabelText("Password");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("plain");
    expect((input as HTMLInputElement).selectionStart).toBe(5);
    expect(latest.current.password).toBe("plain");
    expect(screen.getByRole("button", { name: "Move to secret variable" })).toBeInTheDocument();
  });

  it("doesn't take focus when the value changes from outside", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ type: "bearer", token: "lit" }} />);
    const outside = screen.getByRole("button", { name: "Set from outside" });
    await user.click(outside);
    expect(fieldText("Token")).toBe("{{fromOutside}}");
    expect(outside).toHaveFocus();
    act(() => screen.getByRole("textbox", { name: "Token" }).focus());
    expect(editorView("Token").hasFocus).toBe(true);
  });

  it("covers the API key value too", () => {
    render(<Host initial={{ type: "apikey", apiValue: "{{apiKey}}" }} />);
    expect(fieldText("Value")).toBe("{{apiKey}}");
  });
});

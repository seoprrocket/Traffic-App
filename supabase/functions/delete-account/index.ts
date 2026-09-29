// Account deletion (required by the App Store and Play Store).
// Deletes the signed-in person's account; every table cascades from auth.users.
import { serve, requireUser, readJson, HttpError, admin } from "../_shared/http.ts";

serve(async (req) => {
  const user = await requireUser(req);
  const { confirm } = await readJson<{ confirm?: string }>(req);
  if (confirm !== "DELETE") throw new HttpError(400, "Confirmation missing.");
  const { error } = await admin().auth.admin.deleteUser(user.id);
  if (error) throw error;
  return { ok: true };
});

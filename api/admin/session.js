import { route } from "../_lib/server.js";
import { requireStaff } from "../_lib/admin.js";
import { sessionBody } from "../_lib/staff.js";

export default route("GET", async (req, res) => {
  const staff = await requireStaff(req, res);
  return res.status(200).json(sessionBody(staff));
});

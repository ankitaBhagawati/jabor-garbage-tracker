import { rateLimit, route, serviceRest } from "./_lib/server.js";

// Reference data for the public report form: the municipalities that ask the municipal-area
// question, where they ask it, and their wards. Read with the service role so no table has to be
// opened to anon. Returns names and ward numbers only: no ids of municipalities, no settings.
export default route("GET", async (req, res) => {
  await rateLimit(req, "municipalities", 60, 10 * 60);

  const rows = await serviceRest("/rest/v1/municipalities?is_active=eq.true&select=id,name,settings&order=name");
  const asking = rows.filter(m => m.settings?.public_form?.district && Array.isArray(m.settings.public_form.constituencies));
  if (asking.length === 0) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    return res.status(200).json({ municipalities: [] });
  }

  const ids = asking.map(m => m.id).join(",");
  const [wards, localities] = await Promise.all([
    serviceRest(`/rest/v1/wards?municipality_id=in.(${ids})&select=id,municipality_id,number,name&order=number`),
    serviceRest(`/rest/v1/ward_localities?municipality_id=in.(${ids})&select=ward_id,name&order=name`),
  ]);

  const municipalities = asking.map(m => ({
    name: m.name,
    district: m.settings.public_form.district,
    constituencies: m.settings.public_form.constituencies,
    wards: wards
      .filter(w => w.municipality_id === m.id)
      .map(w => ({
        id: w.id,
        number: w.number,
        name: w.name,
        // A few locality names help a reporter who does not know the ward number.
        localities: localities.filter(l => l.ward_id === w.id).slice(0, 3).map(l => l.name),
      })),
  }));

  // Ward names and localities change rarely; five minutes of caching is plenty.
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return res.status(200).json({ municipalities });
});

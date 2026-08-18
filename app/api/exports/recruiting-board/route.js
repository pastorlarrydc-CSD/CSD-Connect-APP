import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

const STATUS_LABEL = { submitted: "Submitted", reviewed: "Reviewed", contacted: "Contacted" };

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B1F3A" } };
const HEADER_FONT = { color: { argb: "FFFFFFFF" }, bold: true };
const WATCHLIST_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F3EA" } };
const NO_CONTACT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDECEC" } };

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
}

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

export async function GET(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("college_id")
      .eq("id", userData.user.id)
      .maybeSingle();

    const collegeId = profile?.college_id || null;
    let college = null;
    if (collegeId) {
      const { data: c } = await supabase.from("colleges").select("id,name").eq("id", collegeId).maybeSingle();
      college = c;
    }

    // Prospects joined to their high school, for the Recruiting Board sheet.
    const { data: prospects, error: prospectsErr } = await supabase
      .from("prospects")
      .select(
        "id,athlete_name,grad_year,position,level_of_play,gpa,height,weight,hudl_url,x_url,athlete_email,athlete_cell,guardian_authorized,status,created_at,school_id,schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office)"
      )
      .order("created_at", { ascending: false })
      .limit(5000);
    if (prospectsErr) throw prospectsErr;

    let watchlistSet = new Set();
    let contactLogs = [];
    let lastContactBySchool = {};
    let territories = [];
    let territoryCoverage = [];

    if (collegeId) {
      const [{ data: watchlist }, { data: contacts }, { data: terrs }] = await Promise.all([
        supabase.from("watchlist_items").select("school_id").eq("college_id", collegeId),
        supabase
          .from("contact_logs")
          .select("school_id,contact_date,contact_type,note,schools(name,state)")
          .eq("college_id", collegeId)
          .order("contact_date", { ascending: false }),
        supabase.from("territories").select("id,name,states").eq("college_id", collegeId).order("created_at", { ascending: true }),
      ]);
      watchlistSet = new Set((watchlist || []).map((w) => w.school_id));
      contactLogs = contacts || [];
      contactLogs.forEach((c) => {
        if (!lastContactBySchool[c.school_id]) lastContactBySchool[c.school_id] = c;
      });
      territories = terrs || [];

      if (territories.length) {
        const contactedIdsByState = {};
        contactLogs.forEach((c) => {
          const st = c.schools?.state;
          if (!st) return;
          (contactedIdsByState[st] = contactedIdsByState[st] || new Set()).add(c.school_id);
        });
        territoryCoverage = await Promise.all(
          territories.map(async (t) => {
            const { count: total } = await supabase
              .from("schools")
              .select("*", { count: "exact", head: true })
              .in("state", t.states || []);
            const contacted = (t.states || []).reduce((sum, st) => sum + (contactedIdsByState[st]?.size || 0), 0);
            return { name: t.name, states: (t.states || []).join(", "), total: total || 0, contacted };
          })
        );
      }
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "CSD CoachConnect";
    workbook.created = new Date();

    // --- Sheet 1: Recruiting Board ---
    const boardSheet = workbook.addWorksheet("Recruiting Board");
    boardSheet.columns = [
      { header: "Athlete", key: "athlete", width: 22 },
      { header: "Grad Year", key: "grad_year", width: 10 },
      { header: "Position", key: "position", width: 10 },
      { header: "Level of Play", key: "level", width: 12 },
      { header: "GPA", key: "gpa", width: 8 },
      { header: "Height", key: "height", width: 8 },
      { header: "Weight", key: "weight", width: 8 },
      { header: "Athlete Email", key: "athlete_email", width: 26 },
      { header: "Athlete Cell", key: "athlete_cell", width: 16 },
      { header: "Guardian Auth.", key: "guardian", width: 12 },
      { header: "Hudl", key: "hudl", width: 28 },
      { header: "X (Twitter)", key: "x_url", width: 24 },
      { header: "High School", key: "school", width: 26 },
      { header: "City", key: "city", width: 16 },
      { header: "State", key: "state", width: 7 },
      { header: "HS Head Coach", key: "hc_name", width: 20 },
      { header: "HC Email", key: "hc_email", width: 26 },
      { header: "HC Cell", key: "hc_cell", width: 16 },
      { header: "HC Office", key: "hc_office", width: 16 },
      { header: "On Watchlist", key: "watchlisted", width: 12 },
      { header: "Last Contact Date", key: "last_contact_date", width: 14 },
      { header: "Last Contact Type", key: "last_contact_type", width: 14 },
      { header: "Prospect Status", key: "status", width: 14 },
      { header: "Submitted", key: "submitted", width: 12 },
    ];
    styleHeaderRow(boardSheet.getRow(1));
    boardSheet.autoFilter = { from: "A1", to: "X1" };

    (prospects || []).forEach((p) => {
      const watchlisted = p.school_id ? watchlistSet.has(p.school_id) : false;
      const lastContact = p.school_id ? lastContactBySchool[p.school_id] : null;
      const row = boardSheet.addRow({
        athlete: p.athlete_name,
        grad_year: p.grad_year || "",
        position: p.position || "",
        level: p.level_of_play || "",
        gpa: p.gpa ?? "",
        height: p.height || "",
        weight: p.weight || "",
        athlete_email: p.athlete_email || "",
        athlete_cell: fmtPhone(p.athlete_cell),
        guardian: p.guardian_authorized ? "Confirmed" : "Not confirmed",
        hudl: p.hudl_url || "",
        x_url: p.x_url || "",
        school: p.schools?.name || "",
        city: p.city || p.schools?.city || "",
        state: p.state || p.schools?.state || "",
        hc_name: [p.schools?.hc_first_name, p.schools?.hc_last_name].filter(Boolean).join(" "),
        hc_email: p.schools?.hc_email || "",
        hc_cell: fmtPhone(p.schools?.hc_cell),
        hc_office: fmtPhone(p.schools?.hc_office),
        watchlisted: watchlisted ? "Yes" : "No",
        last_contact_date: lastContact?.contact_date || "",
        last_contact_type: lastContact?.contact_type || "",
        status: STATUS_LABEL[p.status] || p.status || "",
        submitted: p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : "",
      });
      if (watchlisted) row.fill = WATCHLIST_FILL;
      else if (!lastContact) row.fill = NO_CONTACT_FILL;
    });

    // --- Sheet 2: Contact Activity Log ---
    const contactSheet = workbook.addWorksheet("Contact Activity Log");
    contactSheet.columns = [
      { header: "School", key: "school", width: 28 },
      { header: "State", key: "state", width: 8 },
      { header: "Date", key: "date", width: 14 },
      { header: "Type", key: "type", width: 14 },
      { header: "Note", key: "note", width: 50 },
    ];
    styleHeaderRow(contactSheet.getRow(1));
    contactLogs.forEach((c) => {
      contactSheet.addRow({
        school: c.schools?.name || "",
        state: c.schools?.state || "",
        date: c.contact_date || "",
        type: c.contact_type || "",
        note: c.note || "",
      });
    });
    if (!contactLogs.length) {
      contactSheet.addRow({ school: "No contacts logged yet for your college." });
    }

    // --- Sheet 3: Territory Coverage ---
    const territorySheet = workbook.addWorksheet("Territory Coverage");
    territorySheet.columns = [
      { header: "Territory", key: "name", width: 22 },
      { header: "States", key: "states", width: 20 },
      { header: "Total Schools", key: "total", width: 14 },
      { header: "Contacted", key: "contacted", width: 12 },
      { header: "Coverage %", key: "coverage", width: 12 },
    ];
    styleHeaderRow(territorySheet.getRow(1));
    territoryCoverage.forEach((t) => {
      territorySheet.addRow({
        name: t.name,
        states: t.states,
        total: t.total,
        contacted: t.contacted,
        coverage: t.total ? `${Math.round((t.contacted / t.total) * 100)}%` : "0%",
      });
    });
    if (!territoryCoverage.length) {
      territorySheet.addRow({ name: "No territories set up yet." });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `csd-recruiting-board-${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("recruiting-board export error", err);
    return NextResponse.json({ error: "Could not build the export. Please try again." }, { status: 500 });
  }
}

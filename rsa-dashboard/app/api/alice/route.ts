import { localRequest } from "@/lib/data";
import { aliceState, recordAliceConsumer, setAliceTarget } from "@/lib/alice-state";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    localRequest(request);
    return Response.json(aliceState(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const input = await request.json();
    return Response.json(await setAliceTarget(input.project, input.ifUnset === true));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    return Response.json(recordAliceConsumer(await request.json()));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

import { classifyConversationalRoute } from "./conversational-routing.ts";
import { classifyNaturalCustomerIntent } from "./natural-customer-response.ts";

const greetings = ["Hi", "你好", "早晨", "Hi / 你好", "Hello，早晨"];

for (const text of greetings) {
  Deno.test(`pure greeting: ${text}`, () => {
    const route = classifyConversationalRoute(text);
    if (route.kind !== "conversational" || route.subtype !== "greeting") {
      throw new Error(`${text}: ${JSON.stringify(route)}`);
    }
    const intent = classifyNaturalCustomerIntent(text);
    if (intent.kind !== "greeting") {
      throw new Error(`${text}: ${JSON.stringify(intent)}`);
    }
  });
}

Deno.test("greeting prefix preserves AC product guidance", () => {
  const text = "Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好";
  const route = classifyConversationalRoute(text);
  if (route.kind !== "normal") throw new Error(JSON.stringify(route));
  const intent = classifyNaturalCustomerIntent(text);
  if (intent.kind !== "product_guidance" || intent.product !== "冷氣") {
    throw new Error(JSON.stringify(intent));
  }
});

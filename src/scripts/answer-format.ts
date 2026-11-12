export type Answer = string | string[] | boolean;

export function formatAnswer(options: readonly { id: string; text: string }[], answer: Answer) {
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  return (Array.isArray(answer) ? answer : [answer]).map((id) => {
    const option = options.find((item) => item.id === id);
    return option ? id + "．" + option.text : id;
  }).join("；");
}

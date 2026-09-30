// 模型侧文本裁剪：工具结果超过 pi 的上下文预算时保留开头、把完整内容落盘。
// 故意不依赖 pi 运行时（上限与格式化由调用方注入），这样才能离线测试。

export interface CapLimits {
	maxLines: number;
	maxBytes: number;
	formatSize: (bytes: number) => string;
}

export interface CappedText {
	/** 实际给模型看的文本（未截断时与输入相同） */
	text: string;
	truncated: boolean;
	/** 截断提示（未截断时为 undefined） */
	notice?: string;
}

/** 按「行数或字节数先到为准」保留开头；字节切分不会切出半个 UTF-8 字符 */
export function capModelText(input: string, limits: CapLimits): CappedText {
	const totalLines = input.split("\n").length;
	const totalBytes = Buffer.byteLength(input, "utf8");
	if (totalLines <= limits.maxLines && totalBytes <= limits.maxBytes) {
		return { text: input, truncated: false };
	}

	let head = input.split("\n").slice(0, limits.maxLines).join("\n");
	let bytes = Buffer.byteLength(head, "utf8");
	if (bytes > limits.maxBytes) {
		let sliced = Buffer.from(head, "utf8").subarray(0, limits.maxBytes).toString("utf8");
		if (sliced.endsWith("\uFFFD")) sliced = sliced.slice(0, -1); // 去掉被切断的半截字符
		head = sliced;
		bytes = Buffer.byteLength(head, "utf8");
	}
	const outputLines = head.split("\n").length;

	return {
		text: head,
		truncated: true,
		notice:
			`\n\n[输出被截断：${outputLines}/${totalLines} 行，` +
			`${limits.formatSize(bytes)}/${limits.formatSize(totalBytes)}。完整结果见 {path}]`,
	};
}

export function withNotice(capped: CappedText, fullOutputPath: string): string {
	if (!capped.truncated || !capped.notice) return capped.text;
	return `${capped.text}${capped.notice.replace("{path}", fullOutputPath)}`;
}

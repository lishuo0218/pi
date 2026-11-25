// 防抖（debounce）示例：在连续调用中只执行最后一次，适合搜索框、窗口缩放等场景。
// 运行：node webui/examples/debounce.ts

export type Debounced<A extends unknown[]> = {
	(...args: A): void;
	/** 取消尚未触发的调用 */
	cancel(): void;
	/** 立即执行尚未触发的调用 */
	flush(): void;
};

export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay: number): Debounced<A> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastArgs: A | undefined;

	const invoke = () => {
		timer = undefined;
		const args = lastArgs;
		lastArgs = undefined;
		if (args !== undefined) fn(...args);
	};

	const debounced = (...args: A) => {
		lastArgs = args;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(invoke, delay);
	};

	debounced.cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		lastArgs = undefined;
	};

	debounced.flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		invoke();
	};

	return debounced;
}

// ---- 演示：模拟输入框，100ms 内连续输入只触发一次搜索 ----

const search = debounce((keyword: string) => console.log(`搜索: "${keyword}"`), 100);

search("a");
search("ab");
search("abc"); // 前两次被 100ms 窗口吞掉
await new Promise((resolve) => setTimeout(resolve, 150));

// cancel 用于在组件卸载等场景丢弃待执行调用
const resize = debounce((width: number) => console.log(`宽: ${width}`), 50);
resize(1920);
resize(1280);
resize.cancel(); // 待执行调用被丢弃，不会有输出

// flush 用于提交前拿到最新值
const save = debounce((value: string) => console.log(`保存: ${value}`), 100);
save("第一版");
save("第二版");
save.flush(); // 立即执行，输出「保存: 第二版」

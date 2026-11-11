// Skeleton generators for common problem shapes, in every supported language.
//
// These are deliberately minimal: they produce a runnable scaffold that reads
// from stdin and writes to stdout, which is what OJs expect. They are a starting
// point for the agent, not a substitute for solving the problem.

/** Per-language: comment marker, entrypoint wrapper, and read helpers. */
const SPEC = {
  python: {
    comment: '#',
    wrap: (body, fname) => `${body}`,
    sortTemplate: `import sys

def main() -> None:
    data = sys.stdin.read().split()
    if not data:
        return
    nums = list(map(int, data))
    nums.sort()
    print(' '.join(map(str, nums)))

if __name__ == "__main__":
    main()
`,
    fibTemplate: `import sys

def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

def main() -> None:
    data = sys.stdin.read().split()
    if data:
        print(fib(int(data[0])))

if __name__ == "__main__":
    main()
`,
    aplusbTemplate: `import sys

def main() -> None:
    data = sys.stdin.read().split()
    if len(data) >= 2:
        print(int(data[0]) + int(data[1]))

if __name__ == "__main__":
    main()
`,
  },

  cpp: {
    comment: '//',
    sortTemplate: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    vector<long long> a;
    long long x;
    while (cin >> x) a.push_back(x);
    sort(a.begin(), a.end());
    for (size_t i = 0; i < a.size(); ++i) {
        if (i) cout << ' ';
        cout << a[i];
    }
    cout << '\\n';
    return 0;
}
`,
    fibTemplate: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    long long n;
    if (!(cin >> n)) return 0;
    long long a = 0, b = 1;
    for (long long i = 0; i < n; ++i) {
        long long t = (a + b) % 1000000007LL;
        a = b;
        b = t;
    }
    cout << a << '\\n';
    return 0;
}
`,
    aplusbTemplate: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    long long a, b;
    if (cin >> a >> b) cout << a + b << '\\n';
    return 0;
}
`,
  },

  c: {
    comment: '//',
    sortTemplate: `#include <stdio.h>
#include <stdlib.h>

int cmp(const void *a, const void *b) {
    long long x = *(const long long *)a, y = *(const long long *)b;
    return (x > y) - (x < y);
}

int main(void) {
    long long a[100005];
    int n = 0;
    while (n < 100005 && scanf("%lld", &a[n]) == 1) n++;
    qsort(a, n, sizeof(long long), cmp);
    for (int i = 0; i < n; i++) {
        if (i) putchar(' ');
        printf("%lld", a[i]);
    }
    putchar('\\n');
    return 0;
}
`,
    fibTemplate: `#include <stdio.h>

int main(void) {
    long long n;
    if (scanf("%lld", &n) != 1) return 0;
    long long a = 0, b = 1;
    for (long long i = 0; i < n; i++) {
        long long t = (a + b) % 1000000007LL;
        a = b;
        b = t;
    }
    printf("%lld\\n", a);
    return 0;
}
`,
    aplusbTemplate: `#include <stdio.h>

int main(void) {
    long long a, b;
    if (scanf("%lld %lld", &a, &b) == 2) printf("%lld\\n", a + b);
    return 0;
}
`,
  },

  java: {
    comment: '//',
    sortTemplate: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        ArrayList<Long> a = new ArrayList<>();
        while (in.nextToken() != StreamTokenizer.TT_EOF) {
            a.add((long) in.nval);
        }
        Collections.sort(a);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.size(); i++) {
            if (i > 0) sb.append(' ');
            sb.append(a.get(i));
        }
        System.out.println(sb);
    }
}
`,
    fibTemplate: `import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        if (in.nextToken() == StreamTokenizer.TT_EOF) return;
        long n = (long) in.nval;
        long a = 0, b = 1;
        for (long i = 0; i < n; i++) {
            long t = (a + b) % 1000000007L;
            a = b;
            b = t;
        }
        System.out.println(a);
    }
}
`,
    aplusbTemplate: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        if (in.nextToken() == StreamTokenizer.TT_EOF) return;
        long a = (long) in.nval;
        if (in.nextToken() == StreamTokenizer.TT_EOF) return;
        long b = (long) in.nval;
        System.out.println(a + b);
    }
}
`,
  },

  javascript: {
    comment: '//',
    sortTemplate: `const fs = require('fs');

function main() {
  const data = fs.readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
  if (!data.length) return;
  const nums = data.map(Number).sort((a, b) => a - b);
  console.log(nums.join(' '));
}

main();
`,
    fibTemplate: `const fs = require('fs');

function fib(n) {
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) {
    const t = (a + b) % 1000000007;
    a = b;
    b = t;
  }
  return a;
}

function main() {
  const data = fs.readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
  if (data.length) console.log(fib(Number(data[0])));
}

main();
`,
    aplusbTemplate: `const fs = require('fs');

function main() {
  const data = fs.readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
  if (data.length >= 2) console.log(Number(data[0]) + Number(data[1]));
}

main();
`,
  },

  go: {
    comment: '//',
    sortTemplate: `package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var nums []int64
	var x int64
	for {
		if _, err := fmt.Fscan(in, &x); err != nil {
			break
		}
		nums = append(nums, x)
	}
	sort.Slice(nums, func(i, j int) bool { return nums[i] < nums[j] })
	for i, v := range nums {
		if i > 0 {
			fmt.Print(" ")
		}
		fmt.Print(v)
	}
	fmt.Println()
}
`,
    fibTemplate: `package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var n int64
	if _, err := fmt.Fscan(in, &n); err != nil {
		return
	}
	var a, b int64 = 0, 1
	for i := int64(0); i < n; i++ {
		t := (a + b) % 1000000007
		a, b = b, t
	}
	fmt.Println(a)
}
`,
    aplusbTemplate: `package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var a, b int64
	if _, err := fmt.Fscan(in, &a, &b); err != nil {
		return
	}
	fmt.Println(a + b)
}
`,
  },

  rust: {
    comment: '//',
    sortTemplate: `use std::io::{self, Read};

fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut v: Vec<i64> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    v.sort();
    let out: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    println!("{}", out.join(" "));
}
`,
    fibTemplate: `use std::io::{self, Read};

fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let n: u64 = match s.split_whitespace().next().and_then(|x| x.parse().ok()) {
        Some(v) => v,
        None => return,
    };
    let (mut a, mut b): (u64, u64) = (0, 1);
    for _ in 0..n {
        let t = (a + b) % 1_000_000_007;
        a = b;
        b = t;
    }
    println!("{}", a);
}
`,
    aplusbTemplate: `use std::io::{self, Read};

fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let v: Vec<i64> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    if v.len() >= 2 {
        println!("{}", v[0] + v[1]);
    }
}
`,
  },

  csharp: {
    comment: '//',
    sortTemplate: `using System;
using System.Linq;

class Program {
    static void Main() {
        var nums = Console.In.ReadToEnd()
            .Split((char[])null, StringSplitOptions.RemoveEmptyEntries)
            .Select(long.Parse)
            .OrderBy(x => x)
            .ToList();
        Console.WriteLine(string.Join(" ", nums));
    }
}
`,
    fibTemplate: `using System;

class Program {
    static void Main() {
        var t = Console.In.ReadToEnd().Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        if (t.Length == 0) return;
        long n = long.Parse(t[0]);
        long a = 0, b = 1;
        for (long i = 0; i < n; i++) {
            long c = (a + b) % 1000000007;
            a = b;
            b = c;
        }
        Console.WriteLine(a);
    }
}
`,
    aplusbTemplate: `using System;

class Program {
    static void Main() {
        var t = Console.In.ReadToEnd().Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        if (t.Length < 2) return;
        Console.WriteLine(long.Parse(t[0]) + long.Parse(t[1]));
    }
}
`,
  },

  kotlin: {
    comment: '//',
    sortTemplate: `fun main() {
    val nums = generateSequence(::readLine)
        .flatMap { it.split(' ').asSequence() }
        .filter { it.isNotBlank() }
        .map { it.toLong() }
        .sorted()
        .toList()
    println(nums.joinToString(" "))
}
`,
    fibTemplate: `fun main() {
    val n = readLine()?.trim()?.toLongOrNull() ?: return
    var a = 0L
    var b = 1L
    repeat(n.toInt()) {
        val t = (a + b) % 1000000007L
        a = b
        b = t
    }
    println(a)
}
`,
    aplusbTemplate: `fun main() {
    val t = readLine()?.trim()?.split(Regex("\\\\s+")) ?: return
    if (t.size < 2) return
    println(t[0].toLong() + t[1].toLong())
}
`,
  },
};

/** Map a canonical language to the skeleton spec key. */
function specKey(lang) {
  return SPEC[lang] ? lang : 'python';
}

/** Detect which template shape a question needs. */
function shapeOf(q) {
  const text = `${q.heading ?? ''} ${q.body ?? ''}`;
  if (/a\s*\+\s*b|两数之和|求和|sum of two|a\+b/i.test(text)) return 'aplusb';
  if (/斐波那契|fibonacci/i.test(text)) return 'fib';
  if (/排序|sort/i.test(text)) return 'sort';
  return null;
}

/**
 * Produce a runnable skeleton for a detected question shape.
 * @returns {string|null} null when no shape matched
 */
export function templateFor(q, lang = 'python') {
  const key = specKey(lang);
  const shape = shapeOf(q);
  if (!shape) return null;
  const tpl = SPEC[key][`${shape}Template`];
  return tpl ?? null;
}

/** Language ids that have a template. */
export function templateLanguages() {
  return Object.keys(SPEC);
}

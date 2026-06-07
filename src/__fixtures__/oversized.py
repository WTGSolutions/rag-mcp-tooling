# oversized.py — fixture for TASK-028 symbol windowing tests.
# big() has 21 body lines (~82 tokens); small() fits in any budget.

def big(x):
    aa = x + 1
    bb = x + 2
    cc = x + 3
    dd = x + 4
    ee = x + 5
    ff = x + 6
    gg = x + 7
    hh = x + 8
    ii = x + 9
    jj = x + 10
    kk = x + 11
    ll = x + 12
    mm = x + 13
    nn = x + 14
    oo = x + 15
    pp = x + 16
    qq = x + 17
    rr = x + 18
    ss = x + 19
    tt = x + 20
    return aa


def small():
    return 42


# A documented oversized function: this leading comment must NOT become the
# window anchor — the declaration `def documented(y):` should be repeated in
# every sub-window so each carries the symbol's identity (TASK-028 anchor fix).
def documented(y):
    a1 = y + 1
    b2 = y + 2
    c3 = y + 3
    d4 = y + 4
    e5 = y + 5
    f6 = y + 6
    g7 = y + 7
    h8 = y + 8
    i9 = y + 9
    j10 = y + 10
    k11 = y + 11
    l12 = y + 12
    m13 = y + 13
    n14 = y + 14
    o15 = y + 15
    p16 = y + 16
    q17 = y + 17
    r18 = y + 18
    s19 = y + 19
    t20 = y + 20
    return a1

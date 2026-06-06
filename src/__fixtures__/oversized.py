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
